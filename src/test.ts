import Spinnies from 'spinnies';

const spinnies = new Spinnies();

spinnies.add("botLoop", { text: "Waiting to start"})
spinnies.add('liqSpinner', { status: 'stopped', text: 'Waiting for initial check'})
spinnies.add('getUsers', { status: 'stopped', text: 'Waiting for initial check'})
spinnies.add('subscribeUsers', { status: 'stopped', text: 'Waiting for initial check'})
spinnies.add('liqDistanceUpdate', { status: 'stopped', text: 'Waiting for initial check'})
spinnies.add('loopSpinner', { status: 'stopped', text: 'Waiting for initial check'})
