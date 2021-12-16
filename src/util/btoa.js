export const btoa = (text) => {
    return Buffer.from(text, 'binary').toString('base64');
};