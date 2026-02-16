const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const config = require('./config');

const RPC_URL = config.RPC_URL;
const WSS_URL = config.WSS_URL;

console.log('🌑 VOID PROTOCOL: RPC Connection Test (Debug Mode)');
console.log(`📡 Testing RPC: ${RPC_URL.slice(0, 40)}...`);
console.log(`📡 Testing WSS: ${WSS_URL.slice(0, 40)}...`);

async function testRPC() {
    try {
        console.log('\n[1/3] Testing HTTP RPC Connection...');
        const connection = new Connection(RPC_URL, 'confirmed');
        const slot = await connection.getSlot();
        console.log(`✅ RPC Success! Current Slot: ${slot}`);
        return true;
    } catch (e) {
        console.error(`❌ RPC Failed: ${e.message}`);
        if (e.message.includes('403')) console.error('⚠️  Error 403: Forbidden (Your IP is blocked or API Key is invalid).');
        if (e.message.includes('429')) console.error('⚠️  Error 429: Rate Limited (Too many requests).');
        return false;
    }
}

async function testWSS() {
    console.log('\n[2/3] Testing WebSocket Connection (WSS)...');
    return new Promise((resolve) => {
        const ws = new WebSocket(WSS_URL);
        
        const timeout = setTimeout(() => {
            console.error('❌ WSS Timeout (10s): Connection hung.');
            ws.terminate();
            resolve(false);
        }, 10000);

        ws.on('open', () => {
            console.log('✅ WSS Connected! Socket is Open.');
            // Send a subscription request to verify it works
            const subscribeMsg = {
                jsonrpc: "2.0",
                id: 1,
                method: "logsSubscribe",
                params: [
                    { mentions: [ "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" ] }, // Raydium
                    { commitment: "confirmed" }
                ]
            };
            ws.send(JSON.stringify(subscribeMsg));
            console.log('📡 Sent subscription request...');
        });

        ws.on('message', (data) => {
            console.log(`✅ WSS Message Received: ${data.toString().slice(0, 100)}...`);
            clearTimeout(timeout);
            ws.close();
            resolve(true);
        });

        ws.on('error', (err) => {
            console.error(`❌ WSS Error: ${err.message}`);
            clearTimeout(timeout);
            resolve(false);
        });

        ws.on('close', (code, reason) => {
            console.log(`⚠️ WSS Closed. Code: ${code}, Reason: ${reason}`);
        });
    });
}

async function main() {
    const rpcOk = await testRPC();
    const wssOk = await testWSS();

    console.log('\n[3/3] Final Verdict:');
    if (rpcOk && wssOk) {
        console.log('✅ GREEN LIGHT: Connection is healthy. The bot should work.');
    } else {
        console.log('❌ RED LIGHT: Connection issues detected.');
        if (!rpcOk) console.log('👉 RPC endpoint is down or blocking you.');
        if (!wssOk) console.log('👉 WSS endpoint is failing (Firewall? API Key?).');
    }
}

main().catch(console.error);
