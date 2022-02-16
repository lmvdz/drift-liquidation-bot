import { Commitment, ConfirmOptions, Connection, ConnectionConfig, Message, PublicKey, SendOptions, Signer, Transaction, TransactionSignature } from "@solana/web3.js";
import { default as Denque } from 'denque';
import dgram from 'dgram';
import bs58 from 'bs58';

export class LeaderTpuCache {
    leaderTpuMap: Map<string, string>
    connection: Connection
    first_slot: number
    slots_in_epoch: number
    last_epoch_info_slot: number
    leaders: Array<PublicKey>
    constructor(connection: Connection, startSlot: number) {
        this.connection = connection;
        this.first_slot = startSlot;
    }
    static load(connection : Connection, startSlot: number) : Promise<LeaderTpuCache> {
        return new Promise((resolve) => {
            let leaderTpuCache = new LeaderTpuCache(connection, startSlot);
            leaderTpuCache.connection.getEpochInfo().then(epochInfo => {
                leaderTpuCache.slots_in_epoch = epochInfo.slotsInEpoch;
                leaderTpuCache.fetchSlotLeaders(leaderTpuCache.first_slot, leaderTpuCache.slots_in_epoch).then((leaders) => {
                    leaderTpuCache.leaders = leaders;
                    leaderTpuCache.fetchClusterTpuSockets().then(leaderTpuMap => {
                        leaderTpuCache.leaderTpuMap = leaderTpuMap;
                        resolve(leaderTpuCache);
                    })
                })
            })
        })
        
    }
    fetchClusterTpuSockets() : Promise<Map<string, string>> {
        return new Promise((resolve, reject) => {
            let map = new Map<string, string>();
            this.connection.getClusterNodes().then(contactInfo => {
                contactInfo.forEach(contactInfo => {
                    map.set(contactInfo.pubkey, contactInfo.tpu);
                })
                resolve(map);
            }).catch(error => {
                reject(error);
            })
        })   
    }
    fetchSlotLeaders(start_slot: number, slots_in_epoch: number) : Promise<Array<PublicKey>> {
        let fanout = Math.min((2 * MAX_FANOUT_SLOTS), slots_in_epoch);
        return this.connection.getSlotLeaders(start_slot, fanout)
    }
    lastSlot() : number {
        return this.first_slot + this.leaders.length - 1;
    }
    getSlotLeader(slot: number) : PublicKey | null {
        if (slot >= this.first_slot) {
            let index = slot - this.first_slot;
            return this.leaders[index]
        } else {
            return null;
        }
    }
    getLeaderSockets(current_slot: number, fanout_slots: number) : Promise<Array<string>> {
        return new Promise(async (resolve, reject) => {
            let leaderSet = new Set<string>();
            let leaderSockets = new Array<string>();
            let checkedSlots = 0;
            this.connection.getSlotLeaders(current_slot, fanout_slots).then(slotLeaders => {
                slotLeaders.forEach((leader, index) => {
                    let tpu_socket = this.leaderTpuMap.get(leader.toBase58())
                    if (tpu_socket !== undefined && tpu_socket !== null) {
                        if (!leaderSet.has(leader.toBase58())) {
                            leaderSet.add(leader.toBase58())
                            leaderSockets.push(tpu_socket)
                        }
                    } else {
                        console.log('TPU not available for leader: ', leader.toBase58());
                    }
                    checkedSlots++;
                    if (checkedSlots === fanout_slots) {
                        resolve(leaderSockets)
                    }
                })
                
            })
        })
        
    }
}

export const MAX_SLOT_SKIP_DISTANCE = 48;
export const DEFAULT_FANOUT_SLOTS = 12;
export const MAX_FANOUT_SLOTS = 100;

export class RecentLeaderSlots {
    recent_slots: Denque
    constructor(current_slot: number) {
        this.recent_slots = new Denque();
        this.recent_slots.push(current_slot);
    }
    recordSlot(current_slot: number) {
        this.recent_slots.push(current_slot);
        while(this.recent_slots.length > 12) {
            this.recent_slots.pop();
        }
    }
    estimatedCurrentSlot() {
        if (this.recent_slots.isEmpty()) {
            throw new Error('recent slots is empty');
        }
        let sortedRecentSlots = this.recent_slots.toArray().sort((a, b) => a - b);
        let max_index = sortedRecentSlots.length - 1;
        let median_index = max_index / 2;
        let median_recent_slot = sortedRecentSlots[median_index];
        let expected_current_slot = median_recent_slot + (max_index - median_index);
        let max_reasonable_current_slot = expected_current_slot + MAX_SLOT_SKIP_DISTANCE;
        return sortedRecentSlots.reverse().find(slot => slot <= max_reasonable_current_slot);
    }
}

export interface TpuClientConfig {
    fanoutSlots: number
}

export class TpuClient {
    sendSocket: dgram.Socket
    fanoutSlots: number
    leaderTpuService: LeaderTpuService
    exit: boolean
    connection: Connection
    constructor(connection: Connection, config: TpuClientConfig = { fanoutSlots: DEFAULT_FANOUT_SLOTS }) {
        this.connection = connection;
        this.exit = false;
        this.sendSocket = dgram.createSocket('udp4');
        this.fanoutSlots = Math.max( Math.min(config.fanoutSlots, MAX_FANOUT_SLOTS), 1 )
        console.log('started tpu client');
    }
    static load(connection: Connection, websocketUrl: string = '', config: TpuClientConfig = { fanoutSlots: DEFAULT_FANOUT_SLOTS }) : Promise<TpuClient> {
        return new Promise((resolve) => {
            let tpuClient = new TpuClient(connection, config);
            LeaderTpuService.load(tpuClient.connection, websocketUrl, tpuClient.exit).then((leaderTpuService) => {
                tpuClient.leaderTpuService = leaderTpuService;
                resolve(tpuClient);
            })
        })
    }
    async sendTransaction(transaction: Transaction, signers: Array<Signer>, options?: SendOptions) : Promise<string> {
        if (transaction.nonceInfo) {
            transaction.sign(...signers);
        } else {
            transaction.recentBlockhash = (await this.connection.getRecentBlockhash()).blockhash;
            transaction.sign(...signers);
        }
        let rawTransaction = transaction.serialize();
        return this.sendRawTransaction(rawTransaction);
    }
    async sendRawTransaction(rawTransaction: Buffer | number[] | Uint8Array) : Promise<string> {
        return new Promise((resolve, reject) => {
            this.leaderTpuService.leaderTpuSockets(this.fanoutSlots).then((tpu_addresses) => {
                tpu_addresses.forEach(tpu_address => {
                    this.sendSocket.send(rawTransaction, parseInt(tpu_address.split(':')[1]), tpu_address.split(':')[0], (error, bytes) => {
                        if (!error) {
                            const message = Transaction.from(rawTransaction);
                            resolve(bs58.encode(message.signature));
                        } else {
                            console.error(error);
                            reject(error);
                        }
                    })
                })
            })
        })
    }
}

export class LeaderTpuService {
    recentSlots: RecentLeaderSlots
    leaderTpuCache: LeaderTpuCache
    subscription: number | null
    connection: Connection

    constructor(connection : Connection) {
        this.connection = connection;
    }
    static load(connection : Connection, websocket_url = '', exit: boolean) : Promise<LeaderTpuService> {
        return new Promise((resolve) => {
            let leaderTpuService = new LeaderTpuService(connection)
            leaderTpuService.connection.getSlot('processed').then((start_slot) => {
                leaderTpuService.recentSlots = new RecentLeaderSlots(start_slot);
                LeaderTpuCache.load(connection, start_slot).then(leaderTpuCache => {
                    leaderTpuService.leaderTpuCache = leaderTpuCache;
                    if (websocket_url !== '') {
                        leaderTpuService.subscription = connection.onSlotUpdate((slotUpdate) => {
                            if (slotUpdate.type === 'completed') {
                                slotUpdate.slot++;
                            }
                            leaderTpuService.recentSlots.recordSlot(slotUpdate.slot);
                        })
                    } else {
                        leaderTpuService.subscription = null;
                    }
                    leaderTpuService.run();
                    resolve(leaderTpuService);
                })
            });
        })
        
    }
    leaderTpuSockets(fanout_slots: number) {
        let current_slot = this.recentSlots.estimatedCurrentSlot();
        return this.leaderTpuCache.getLeaderSockets(current_slot, fanout_slots)
    }
    async run() {
        let last_cluster_refresh = Date.now();
        let sleep_ms = 1000;
        setTimeout(async () => {
            sleep_ms = 1000;
            if ( Date.now() - last_cluster_refresh > (1000 * 5 * 60)) {
                try {
                    this.leaderTpuCache.leaderTpuMap = await this.leaderTpuCache.fetchClusterTpuSockets()
                } catch (error) {
                    console.warn('Failed to fetch cluster tpu sockets', error);
                    sleep_ms = 1000;
                }
            }
            let estimatedCurrentSlot = this.recentSlots.estimatedCurrentSlot();
            if (estimatedCurrentSlot >= this.leaderTpuCache.last_epoch_info_slot-this.leaderTpuCache.slots_in_epoch) {
                try {
                    const epochInfo = await this.connection.getEpochInfo('recent');
                    this.leaderTpuCache.slots_in_epoch = epochInfo.slotsInEpoch;
                    this.leaderTpuCache.last_epoch_info_slot = estimatedCurrentSlot;
                } catch (error) {
                    console.warn('failed to get epoch info')
                }
            }
            if (estimatedCurrentSlot >= (this.leaderTpuCache.lastSlot() - MAX_FANOUT_SLOTS)) {
                try {
                    const slot_leaders = await this.leaderTpuCache.fetchSlotLeaders(estimatedCurrentSlot, this.leaderTpuCache.slots_in_epoch)
                    this.leaderTpuCache.first_slot = estimatedCurrentSlot
                    this.leaderTpuCache.leaders = slot_leaders
                } catch (error) {
                    console.warn(`Failed to fetch slot leaders (current estimated slot: ${estimatedCurrentSlot})`, error);
                    sleep_ms = 1000;
                }
            }
            this.run();
        }, sleep_ms)
    }
}


export class TpuConnection extends Connection {
    tpuClient: TpuClient

    constructor(endpoint : string, commitmentOrConfig?: Commitment | ConnectionConfig) {
        super(endpoint, commitmentOrConfig)
    }

    sendTransaction(transaction: Transaction, signers: Signer[], options?: SendOptions): Promise<string> {
        return this.tpuClient.sendTransaction(transaction, signers);
    };

    sendRawTransaction(rawTransaction: Buffer | number[] | Uint8Array, options?: SendOptions): Promise<string> {
        return this.tpuClient.sendRawTransaction(rawTransaction);
    };


    async sendAndConfirmTransaction(connection: TpuConnection, transaction: Transaction, signers: Array<Signer>, options?: ConfirmOptions) : Promise<TransactionSignature> {
        const signature = await this.sendTransaction(transaction, signers, options);
        const status = (await connection.confirmTransaction(signature, options.commitment)).value;
        if (status.err) {
            throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
        }
        return signature;
    }

    async sendAndConfirmRawTransaction(connection: TpuConnection, rawTransaction: Buffer | number[] | Uint8Array, options?: ConfirmOptions) {
        const signature = await this.sendRawTransaction(rawTransaction);
        const status = (await connection.confirmTransaction(signature, options.commitment)).value;
        if (status.err) {
            throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
        }
        return signature;
    }


    static load(endpoint: string, commitmentOrConfig?: Commitment | ConnectionConfig) : Promise<TpuConnection> {
        
        return new Promise((resolve) => {
            const tpuConnection = new TpuConnection(endpoint, commitmentOrConfig);
            TpuClient.load(tpuConnection).then(tpuClient => {
                tpuConnection.tpuClient = tpuClient;
                resolve(tpuConnection)
            })
        })
    }
}