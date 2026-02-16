const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Constants
const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const TRADES_FILE = path.join(__dirname, 'paper_trades.json');

// Strategy Configuration
const STRATEGY = {
    minLiquiditySOL: 10,     // Minimum LP to consider (avoid dust/rugs)
    maxLiquiditySOL: 1000,   // Max LP (avoid old/established pairs)
    buyAmountSOL: 0.1,       // Paper trade size (approx $15-20)
    takeProfitMultiplier: 2.0, // Sell 50% at 2x
    stopLossPercent: 0.40,   // Stop loss at -40%
    moonbagPercent: 0.50     // Amount to hold after TP1
};

// Initialize Connection
const connection = new Connection(config.RPC_URL, {
    wsEndpoint: config.WSS_URL,
    commitment: 'confirmed'
});

// State
let trades = [];

// Load existing trades
if (fs.existsSync(TRADES_FILE)) {
    try {
        trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    } catch (e) {
        console.error('Failed to load trades:', e);
        trades = [];
    }
}

function saveTrade(trade) {
    // Check if trade exists, update it
    const index = trades.findIndex(t => t.signature === trade.signature);
    if (index > -1) {
        trades[index] = trade;
    } else {
        trades.push(trade);
    }
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

async function getPoolInfo(signature) {
    try {
        const tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx) return null;

        // Simplified extraction for Raydium V4 'initialize2'
        // We look for the transfer of SOL/WSOL to the pool account to estimate liquidity
        const accounts = tx.transaction.message.accountKeys;
        const postTokenBalances = tx.meta.postTokenBalances;

        // This is a heuristic. In a production bot, we'd decode the instruction data.
        // For now, we check the SOL balance change of the creator or pool.
        
        // Let's just return the signature and timestamp for now to start the loop
        return {
            signature,
            timestamp: Date.now(),
            valid: true // Assume valid for now, we will filter by price check later
        };

    } catch (e) {
        console.error(`Error parsing pool ${signature}:`, e.message);
        return null;
    }
}

// ------------------------------------------------------------------
// 📉 Price & PnL Loop
// ------------------------------------------------------------------
// In a real bot, we would subscribe to price updates or poll the pool directly.
// For this paper version, we will simulate price movement randomly to test the logic,
// OR fetch from DexScreener if we want real data (rate limited).
// Let's use a "Mock Price" for now to prove the Logic Flow.

async function checkPositions() {
    console.log(`\n🔄 Checking ${trades.length} open positions...`);
    
    for (let trade of trades) {
        if (trade.status !== 'OPEN') continue;

        // 1. Get Current Price (Mocked for Paper Test)
        // In real version: await fetchPrice(trade.token)
        const currentPriceMock = trade.entryPrice * (0.8 + Math.random() * 0.5); // Random fluctuation +/-
        
        // 2. Calculate PnL
        const pnlPercent = (currentPriceMock - trade.entryPrice) / trade.entryPrice;
        
        console.log(`Token: ${trade.token.slice(0,6)}... | Entry: ${trade.entryPrice} | Curr: ${currentPriceMock.toFixed(4)} | PnL: ${(pnlPercent * 100).toFixed(2)}%`);

        // 3. Check Exit Conditions
        if (pnlPercent >= (STRATEGY.takeProfitMultiplier - 1)) {
            console.log(`✅ TAKE PROFIT HIT! (+${(pnlPercent*100).toFixed(2)}%)`);
            trade.status = 'TP_HIT';
            trade.exitPrice = currentPriceMock;
            trade.finalPnL = pnlPercent;
            saveTrade(trade);
        } else if (pnlPercent <= -STRATEGY.stopLossPercent) {
            console.log(`🛑 STOP LOSS HIT! (${(pnlPercent*100).toFixed(2)}%)`);
            trade.status = 'STOPPED_OUT';
            trade.exitPrice = currentPriceMock;
            trade.finalPnL = pnlPercent;
            saveTrade(trade);
        }
    }
}

// Run the check loop every 30 seconds
setInterval(checkPositions, 30000);

async function main() {
    console.log('🌑 VOID PROTOCOL: Online (Paper Trading Mode)');
    console.log(`📡 Connected to QuickNode`);
    console.log('👀 Watching for new Raydium Pools...');

    // Subscribe to logs for Raydium V4
    connection.onLogs(
        RAYDIUM_PROGRAM_ID,
        async (logs, context) => {
            if (logs.err) return;

            // Check for 'initialize2' instruction (New Pool Creation)
            const isNewPool = logs.logs.some(log => log.includes('initialize2'));
            
            if (isNewPool) {
                const signature = logs.signature;
                console.log(`\n🆕 NEW POOL DETECTED: https://solscan.io/tx/${signature}`);
                
                // 1. Fetch Pool Info
                const poolInfo = await getPoolInfo(signature);
                
                if (poolInfo && poolInfo.valid) {
                    console.log(`🔹 Simulating Buy for ${signature.slice(0,8)}...`);
                    
                    // 2. Execute Paper Buy
                    const paperTrade = {
                        signature: signature,
                        token: signature, // Using sig as ID for now
                        entryTime: new Date().toISOString(),
                        entryPrice: 1.0, // Normalized base price
                        amount: STRATEGY.buyAmountSOL,
                        status: "OPEN",
                        pnl: 0
                    };

                    saveTrade(paperTrade);
                    console.log(`📝 Trade Logged! Watching for TP/SL...`);
                }
            }
        },
        'confirmed'
    );
}

main().catch(console.error);
