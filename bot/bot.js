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

        // Update High Water Mark for Trailing Stop
        if (!trade.highestPrice || currentPriceMock > trade.highestPrice) {
            trade.highestPrice = currentPriceMock;
        }
        
        // 2. Calculate PnL
        const pnlPercent = (currentPriceMock - trade.entryPrice) / trade.entryPrice;
        
        console.log(`Token: ${trade.token.slice(0,6)}... | Entry: ${trade.entryPrice} | Curr: ${currentPriceMock.toFixed(4)} | High: ${trade.highestPrice.toFixed(4)} | PnL: ${(pnlPercent * 100).toFixed(2)}% | Status: ${trade.status}`);

        // 3. Dynamic Exit Logic
        
        // A) MOONBAG MODE (Already sold 50%, managing the rest)
        if (trade.status === 'MOONBAG') {
            const dropFromHigh = (trade.highestPrice - currentPriceMock) / trade.highestPrice;
            
            // Trailing Stop: If price drops 20% from the peak
            if (dropFromHigh >= 0.20) {
                 console.log(`📉 TRAILING STOP HIT! Dropped ${(dropFromHigh*100).toFixed(1)}% from High. Selling Moonbag.`);
                 trade.status = 'CLOSED_TRAIL';
                 trade.exitPrice = currentPriceMock;
                 trade.finalPnL = (currentPriceMock - trade.entryPrice) / trade.entryPrice; // Real PnL on remaining
                 saveTrade(trade);
                 logDecision("SELL_MOONBAG", { symbol: "UNKNOWN", address: trade.token }, {
                    price: currentPriceMock,
                    liquidity: 0,
                    reason: `Trailing Stop: -${(dropFromHigh*100).toFixed(1)}% from High`
                });
            }
            continue; // Skip the regular TP/SL checks
        }

        // B) REGULAR MODE (Initial Position)
        if (pnlPercent >= (STRATEGY.takeProfitMultiplier - 1)) {
            // HIT 2x -> Sell 50%, Enter Moonbag Mode
            console.log(`🚀 2X HIT! Selling 50% (Freeroll). Switching to Moonbag.`);
            trade.status = 'MOONBAG';
            trade.tpHitPrice = currentPriceMock;
            // In a real bot, we'd record the partial sell tx here
            saveTrade(trade);
            logDecision("SELL_PARTIAL", { symbol: "UNKNOWN", address: trade.token }, {
                price: currentPriceMock,
                liquidity: 0,
                reason: "Hit 2x (Freeroll)"
            });

        } else if (pnlPercent <= -STRATEGY.stopLossPercent) {
            // HIT STOP LOSS -> Sell All
            console.log(`🛑 STOP LOSS HIT! (${(pnlPercent*100).toFixed(2)}%)`);
            trade.status = 'STOPPED_OUT';
            trade.exitPrice = currentPriceMock;
            trade.finalPnL = pnlPercent;
            saveTrade(trade);
            logDecision("SELL_SL", { symbol: "UNKNOWN", address: trade.token }, {
                price: currentPriceMock,
                liquidity: 0,
                reason: "Hard Stop Loss"
            });
        }
    }
}

// Run the check loop every 30 seconds
setInterval(checkPositions, 30000);

// --- LOGGING SYSTEM (v1) ---
function logDecision(action, token, data) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: "TRADE_DECISION",
        action: action, // BUY, SELL, SKIP
        token: token,   // { symbol: "PEPE", address: "..." }
        market: {
            price: data.price,
            liquidity: data.liquidity,
            volume_5m: data.volume_5m || 0
        },
        safety: {
            mint_auth: data.mint_auth || false,
            freeze_auth: data.freeze_auth || false,
            top10_holders: data.top10_holders || 0,
            rugcheck_score: data.rugcheck_score || "N/A"
        },
        reason: data.reason
    };
    console.log("JSON_LOG:", JSON.stringify(logEntry));
}

// ------------------------------------------------------------------
// 🕵️ Wallet Surveillance (Lite)
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// 🕵️ Local Detective (Dev Funding Check)
// ------------------------------------------------------------------
const KNOWN_WALLETS = {
    // CEX Hot Wallets (Safe/Doxxed)
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvu6Fn': 'Binance 1',
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance 2',
    'HuPuX6p5hVj7fQc7Wp9fG8yW9b7G8yW9b7G8yW9b7G8y': 'Coinbase 1', // Placeholder pattern, real ones vary
    'FWznbcNXWQu3oWBB62w8b9nAdWj8GncJa71q5djXk4e': 'Kraken',
    
    // Mixers / Dangerous (Unsafe/Anonymous)
    'AC5RDfQFmDS1deWZosYb21BFUUkC2F2t375A18CqJ93': 'FixedFloat',
    'H8sMJjj9H24wFSUt1Mp8675kPX9MHTjS2zt1qfr1NYHu': 'Tornado Proxy' // Placeholder
};

async function checkDevFunding(connection, devAddress) {
    try {
        const pubkey = new PublicKey(devAddress);
        
        // 1. Get Oldest Transaction (Funding Source)
        // We fetch the last 1 signature, starting from the beginning? 
        // Actually, on Solana, 'before' goes backwards. 'until' goes forward.
        // Getting the *very first* tx is hard without an indexer.
        // We will try to fetch the *earliest* signature we can find.
        
        const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 5 });
        
        // If wallet is brand new, the last signature in the list is likely the funding tx
        if (signatures.length === 0) return { isSafe: true, source: "Unknown (New)" };
        
        const fundingTxSig = signatures[signatures.length - 1].signature;
        
        const tx = await connection.getParsedTransaction(fundingTxSig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx) return { isSafe: true, source: "Unknown (RPC Limit)" };

        // 2. Identify Sender
        // We look for the account that paid the fees or transferred SOL
        const accountKeys = tx.transaction.message.accountKeys;
        const sender = accountKeys[0].pubkey.toString(); // The payer
        
        const knownLabel = KNOWN_WALLETS[sender];
        
        if (knownLabel) {
            if (knownLabel.includes('Binance') || knownLabel.includes('Coinbase') || knownLabel.includes('Kraken')) {
                return { isSafe: true, source: `CEX (${knownLabel})` };
            }
            if (knownLabel.includes('FixedFloat') || knownLabel.includes('Tornado')) {
                return { isSafe: false, source: `MIXER (${knownLabel})` };
            }
        }
        
        return { isSafe: true, source: "Private Wallet" }; // Neutral

    } catch (e) {
        console.error(`Error checking funding for ${devAddress}:`, e.message);
        return { isSafe: true, source: "Check Failed" }; // Fail open for paper trading
    }
}

async function analyzeHolders(connection, tokenMintAddress) {
    try {
        const mintPubkey = new PublicKey(tokenMintAddress);
        
        // 1. Get Top 20 Largest Token Accounts
        const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
        const supplyInfo = await connection.getTokenSupply(mintPubkey);
        const totalSupply = supplyInfo.value.uiAmount;

        let top10Holdings = 0;
        let poolAddress = null; // We need to identify the LP to ignore it
        
        // simple heuristic: The largest holder is usually the LP at launch
        // In a real bot, we'd look up the Raydium pair address specifically.
        
        // Filter and sum
        const holders = largestAccounts.value.slice(0, 10);
        
        // Sort by amount desc (API returns sorted, but good to be sure)
        holders.sort((a, b) => b.uiAmount - a.uiAmount);

        // Assume #1 is LP if it holds > 40% (common for Raydium V4)
        // We skip the largest one for the "Cabal Check"
        const potentialLP = holders[0];
        const startIndex = (potentialLP.uiAmount / totalSupply > 0.40) ? 1 : 0; 

        for (let i = startIndex; i < holders.length; i++) {
            top10Holdings += holders[i].uiAmount;
        }

        const concentration = (top10Holdings / totalSupply) * 100;
        
        return {
            valid: true,
            top10Percent: concentration,
            isSafe: concentration < 30 // Rule: Reject if Top 10 hold > 30%
        };

    } catch (e) {
        console.error(`Error analyzing holders for ${tokenMintAddress}:`, e.message);
        return { valid: false, top10Percent: 0, isSafe: false };
    }
}

// ------------------------------------------------------------------
// 🛡️ Rate Limit Defender (Queue System)
// ------------------------------------------------------------------
class ProcessingQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.lastProcessTime = 0;
        this.minDelay = 200; // ms between checks (5/sec)
        this.backoff = 2000; // ms to wait after error
    }

    add(signature) {
        this.queue.push(signature);
        this.processNext();
    }

    async processNext() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        const signature = this.queue.shift();

        // Rate Limit Check
        const now = Date.now();
        const timeSinceLast = now - this.lastProcessTime;
        if (timeSinceLast < this.minDelay) {
            await new Promise(resolve => setTimeout(resolve, this.minDelay - timeSinceLast));
        }

        try {
            console.log(`\n🚦 Processing Queue: ${this.queue.length} left. Analyzing ${signature.slice(0,8)}...`);
            await analyzePool(signature);
            this.lastProcessTime = Date.now();
        } catch (e) {
            console.error(`⚠️ Queue Error for ${signature}:`, e.message);
            // If Rate Limit hit (429), pause longer
            if (e.message.includes('429')) {
                console.log(`🛑 RATE LIMIT HIT! Pausing for ${this.backoff}ms...`);
                await new Promise(resolve => setTimeout(resolve, this.backoff));
            }
        } finally {
            this.isProcessing = false;
            // Process next item immediately
            if (this.queue.length > 0) {
                this.processNext();
            }
        }
    }
}

const queue = new ProcessingQueue();

// ------------------------------------------------------------------
// 🧠 Core Analysis Logic (Moved from main loop)
// ------------------------------------------------------------------
async function analyzePool(signature) {
    // 1. Fetch Pool Info
    const poolInfo = await getPoolInfo(signature);
    
    if (poolInfo && poolInfo.valid) {
        // 1.5. 🕵️ Dev Funding Check (Local Detective)
        // ... (Logic copied from previous step) ...
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        const creator = tx ? tx.transaction.message.accountKeys[0].pubkey.toString() : null;
        
        if (creator) {
            const fundingCheck = await checkDevFunding(connection, creator);
            if (!fundingCheck.isSafe) {
                 console.log(`❌ UNSAFE FUNDING: Dev funded by ${fundingCheck.source}`);
                 logDecision("SKIP", { symbol: "UNKNOWN", address: signature }, {
                    price: 0,
                    liquidity: 0,
                    reason: `Bad Funding Source: ${fundingCheck.source}`
                });
                return;
            }
            console.log(`✅ FUNDING SAFE: Source -> ${fundingCheck.source}`);
        }

        // 2. 🕵️ Perform Wallet Surveillance (Top 10 Check)
        console.log(`🔹 Analyzing Holders for ${signature.slice(0,8)}...`);
        const holderAnalysis = await analyzeHolders(connection, signature);

        if (!holderAnalysis.valid) {
            console.log(`⚠️ Failed to analyze holders. Skipping safety check.`);
             logDecision("SKIP", { symbol: "UNKNOWN", address: signature }, {
                price: 0,
                liquidity: 0,
                reason: "Holder Analysis Failed"
            });
            return;
        }

        if (!holderAnalysis.isSafe) {
            console.log(`❌ UNSAFE: Top 10 Holders Own ${(holderAnalysis.top10Percent).toFixed(2)}% (Limit: 30%)`);
            logDecision("SKIP", { symbol: "UNKNOWN", address: signature }, {
                price: 0,
                liquidity: 0,
                top10_holders: holderAnalysis.top10Percent,
                reason: `High Concentration: ${(holderAnalysis.top10Percent).toFixed(2)}%`
            });
            return;
        }

        console.log(`✅ SAFE: Top 10 Own ${(holderAnalysis.top10Percent).toFixed(2)}%`);
        console.log(`🔹 Simulating Buy for ${signature.slice(0,8)}...`);
        
        // 3. Execute Paper Buy (with REALISM PENALTIES)
        // A) Slippage (1-3%)
        let slippage = 1.0 + (Math.random() * 0.02 + 0.01); 
        
        // B) MEV Attack Simulation (10% chance to get sandwiched)
        const isSandwiched = Math.random() < 0.10;
        if (isSandwiched) {
            console.log(`🥪 MEV ATTACK! You got sandwiched. Entry price +15%.`);
            slippage += 0.15;
        }

        // C) Priority Fee (Simulated Jito Tip)
        const priorityFee = 0.005; // SOL

        const basePrice = 1.0;
        const realEntryPrice = basePrice * slippage;

        const paperTrade = {
            signature: signature,
            token: signature, // Using sig as ID for now
            entryTime: new Date().toISOString(),
            entryPrice: realEntryPrice, // Adjusted for reality
            basePrice: basePrice,       // The "screen price"
            amount: STRATEGY.buyAmountSOL,
            fees: priorityFee,
            status: "OPEN",
            pnl: 0,
            isSandwiched: isSandwiched,
            safetyMetrics: {
                top10Percent: holderAnalysis.top10Percent
            }
        };

        saveTrade(paperTrade);
        logDecision("BUY", { symbol: "UNKNOWN", address: signature }, {
            price: realEntryPrice,
            liquidity: 0, // Placeholder
            top10_holders: holderAnalysis.top10Percent,
            reason: isSandwiched ? "MEV_ATTACKED_ENTRY" : "Normal_Entry"
        });
        console.log(`📝 Trade Logged! Entry: ${realEntryPrice.toFixed(4)} (Slippage: ${((slippage-1)*100).toFixed(1)}%)`);
    } else {
        logDecision("SKIP", { symbol: "UNKNOWN", address: signature }, {
            price: 0,
            liquidity: 0,
            reason: "Failed Pool Info / Invalid"
        });
    }
}

async function main() {
    console.log('🌑 VOID PROTOCOL: Online (Paper Trading Mode)');
    console.log(`📡 Connected to QuickNode`);
    console.log('👀 Watching for new Raydium Pools...');

    // Subscribe to logs for Raydium V4
    console.log(`🔌 Subscribing to Raydium Program logs...`);
    
    let lastLogTime = Date.now();

    try {
        const subId = connection.onLogs(
            RAYDIUM_PROGRAM_ID,
            async (logs, context) => {
                if (logs.err) return;

                // Update last activity time
                lastLogTime = Date.now();

                // DEBUG: Print first 50 chars of logs to prove connection is alive
                // Only print 1 out of every 10 logs to reduce noise, but prove life
                if (Math.random() < 0.1) {
                    console.log(`📡 Raydium Activity [Sample]: ${logs.signature.slice(0,8)}...`);
                }

                // Check for 'initialize2' instruction (New Pool Creation)
                const isNewPool = logs.logs.some(log => log.includes('initialize2') || log.includes('InitializeInstruction2'));
                
                if (isNewPool) {
                    const signature = logs.signature;
                    console.log(`\n🆕 NEW POOL DETECTED: https://solscan.io/tx/${signature}`);
                    queue.add(signature);
                }
            },
            'confirmed'
        );
        console.log(`✅ Subscription ID: ${subId}`);
    } catch (e) {
        console.error("❌ Failed to subscribe:", e);
    }

    // 🛡️ Watchdog: If no logs for 60s, exit (Railway will restart us)
    setInterval(() => {
        const timeSinceLast = Date.now() - lastLogTime;
        if (timeSinceLast > 60000) {
            console.error(`❌ NO ACTIVITY for 60s! WebSocket might be dead. Exiting to restart...`);
            process.exit(1);
        }
    }, 10000);
}

main().catch(console.error);
