
export const atob = (base64) => {
    return Buffer.from(base64, 'base64').toString('binary');
};