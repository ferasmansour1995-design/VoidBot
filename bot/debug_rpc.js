const { Connection, PublicKey } = require('@solana/web3.js');
require('dotenv').config(); // Load .env file

// Use the config or fallback to process.env
const WSS_URL = process.env.WSS_URL;
const HTTP_URL = process.env.RPC_URL;

if (!WSS_URL || !HTTP_URL) {
    console.error("❌ Missing RPC_URL or WSS_URL in .env");
    process.exit(1);
}

console.log("🔍 Testing RPC Connection...");
console.log(`HTTP: ${HTTP_URL}`);
console.log(`WSS:  ${WSS_URL}`);

const connection = new Connection(HTTP_URL, {
    wsEndpoint: WSS_URL,
    commitment: 'confirmed'
});

const RAYDIUM_PUBLIC_KEY = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

async function main() {
    // 1. Test HTTP (Slot Height)
    try {
        const slot = await connection.getSlot();
        console.log(`✅ HTTP Connection OK. Current Slot: ${slot}`);
    } catch (e) {
        console.error(`❌ HTTP Connection FAILED: ${e.message}`);
        return;
    }

    // 2. Test WebSocket (Logs Subscription)
    console.log("📡 Subscribing to Raydium Logs (waiting 10s)...");
    
    const subId = connection.onLogs(
        RAYDIUM_PUBLIC_KEY,
        (logs) => {
            console.log(`🔥 LOG RECEIVED! Sig: ${logs.signature}`);
            // If we get one, we know it works.
            process.exit(0);
        },
        'confirmed'
    );

    // Timeout after 30 seconds
    setTimeout(() => {
        console.log("❌ No logs received after 30 seconds. WebSocket might be blocked or silent.");
        process.exit(1);
    }, 30000);
}

main();
