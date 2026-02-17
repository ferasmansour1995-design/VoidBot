require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const axios = require('axios');

// --- CONFIGURATION ---
const CONFIG = {
    PAPER_MODE: true,
    RPC_URL: process.env.SOLANA_RPC_URL,
    
    // SCANNING
    SCAN_INTERVAL_MS: 60000,   // Scan trending every 60s (was 30s)
    PRICE_CHECK_MS: 5000,      // Check active trade every 5s (was 3s)
    
    // FILTERS (The "Survivor" Logic)
    MIN_LIQUIDITY_USD: 10000,
    MIN_FDV: 50000,
    MIN_PAIR_AGE_HOURS: 1,     // Avoid brand new rugs
    
    // BLACKLIST (Major tokens to skip in favor of memes)
    BLACKLIST: ['SOL', 'USDC', 'USDT', 'MSOL', 'JUP', 'WIF', 'BONK', 'RAY'], 
    
    // TRADING
    BUY_AMOUNT_USD: 3.33,      // 1/3 of Portfolio per trade
    TAKE_PROFIT: 15.0,         // +15%
    STOP_LOSS: 10.0,           // -10%
    SIM_FEE: 0.02
};

// --- STATE ---
let wallet = { usd: 10.00, history: [] };
let activeTrades = []; // Array of { mint, symbol, entryPrice, tokens, startTime }

const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- AUTH MIDDLEWARE ---
const AUTH_KEY = process.env.API_KEY || 'test-key-123'; // Default for testing, change in prod
const authMiddleware = (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key || key !== AUTH_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
};

// --- LOGGING STORAGE ---
const LOG_HISTORY_SIZE = 100;
let logHistory = [];

function log(msg, type = 'INFO') {
    const ts = new Date().toISOString().substring(11, 19);
    const logEntry = `[${ts}] [${type}] ${msg}`;
    console.log(logEntry);
    
    // Store in memory for API
    logHistory.push({ ts, type, msg });
    if (logHistory.length > LOG_HISTORY_SIZE) {
        logHistory.shift();
    }
}

// --- API ENDPOINTS ---
app.get('/', (req, res) => {
    res.send('VoidBot API Online v1.0');
});

// ENDPOINT 1: All Token Purchases (Open + Closed)
app.get('/api/v1/tokens', authMiddleware, (req, res) => {
    const formatTrade = (t, status) => {
        // For open trades, current is live price (or entry if tick missing). For closed, it's exit price.
        const currentPrice = status === 'open' ? (t.lastPrice || t.entryPrice) : t.exitPrice;
        const totalCost = t.entryPrice * t.tokens;
        const currentValue = currentPrice * t.tokens;
        const pnlUsd = currentValue - totalCost;
        const pnlPercent = ((currentPrice - t.entryPrice) / t.entryPrice) * 100;

        return {
            token_symbol: t.symbol,
            contract_address: t.mint,
            purchase_date: new Date(t.startTime).toISOString(),
            purchase_price: t.entryPrice,
            current_price: currentPrice,
            amount: t.tokens,
            total_cost: totalCost,
            current_value: currentValue,
            pnl_usd: pnlUsd,
            pnl_percentage: pnlPercent,
            status: status
        };
    };

    const openTrades = activeTrades.map(t => formatTrade(t, 'open'));
    const closedTrades = wallet.history.map(t => formatTrade(t, 'closed'));

    res.json([...openTrades, ...closedTrades]);
});

// ENDPOINT 2: Portfolio Summary
app.get('/api/v1/portfolio/summary', authMiddleware, (req, res) => {
    // 1. Calculate Open Position Value
    let openValue = 0;
    let openPnL = 0;
    activeTrades.forEach(t => {
        const curr = t.lastPrice || t.entryPrice;
        openValue += (curr * t.tokens);
        openPnL += (curr - t.entryPrice) * t.tokens;
    });

    // 2. Calculate Closed Metrics
    let closedPnL = 0;
    let wins = 0;
    let totalHoldTime = 0;
    
    // Track Best/Worst
    let bestTrade = null;
    let worstTrade = null;

    wallet.history.forEach(t => {
        const pnl = (t.exitPrice - t.entryPrice) * t.tokens;
        closedPnL += pnl;
        if (pnl > 0) wins++;
        totalHoldTime += (t.endTime - t.startTime);

        if (!bestTrade || pnl > bestTrade.pnl) bestTrade = { symbol: t.symbol, pnl };
        if (!worstTrade || pnl < worstTrade.pnl) worstTrade = { symbol: t.symbol, pnl };
    });

    const totalTrades = activeTrades.length + wallet.history.length;
    const totalPortfolioValue = wallet.usd + openValue;
    const startBalance = 10.00; // Hardcoded start for paper trading
    const totalPnL = totalPortfolioValue - startBalance;
    const pnlPercent = (totalPnL / startBalance) * 100;

    res.json({
        total_portfolio_value: totalPortfolioValue,
        total_pnl_usd: totalPnL,
        total_pnl_percentage: pnlPercent,
        win_rate: totalTrades > 0 ? (wins / wallet.history.length) * 100 : 0, // Win rate based on closed trades
        total_trades: totalTrades,
        best_performer: bestTrade,
        worst_performer: worstTrade,
        average_hold_time_ms: wallet.history.length > 0 ? (totalHoldTime / wallet.history.length) : 0
    });
});

app.get('/api/logs', authMiddleware, (req, res) => {
    res.json(logHistory);
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- SCANNING ---
async function scanForTarget() {
    // Skip scanning if wallet is empty
    if (wallet.usd < CONFIG.BUY_AMOUNT_USD) {
        // log("Wallet below buy threshold. Scanning paused.", 'WAIT');
        return null;
    }
    if (wallet.usd < CONFIG.BUY_AMOUNT_USD) {
        // log("Wallet below buy threshold. Scanning paused.", 'WAIT');
        return null;
    }

    log("Scanning DexScreener (Multi-Source)...", 'SCAN');
    try {
        // Multi-Source Fetch to ensure we find candidates beyond just major pairs
        const sources = [
            `https://api.dexscreener.com/latest/dex/search/?q=solana`, // General Search
            `https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112`, // WSOL Pairs
            `https://api.dexscreener.com/latest/dex/tokens/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` // USDC Pairs
        ];

        const responses = await Promise.all(sources.map(url => axios.get(url, { timeout: 5000 }).catch(e => ({ data: { pairs: [] } }))));
        
        // Combine and Deduplicate
        const allPairs = responses.flatMap(r => r.data.pairs || []);
        const uniquePairs = Array.from(new Map(allPairs.map(p => [p.pairAddress, p])).values());

        // Apply "Survivor" Filters
        const candidates = uniquePairs.filter(p => {
            const liq = p.liquidity?.usd || 0;
            
            // Determine which side is the target token (not SOL/USDC)
            let targetToken = null;
            if (p.baseToken.symbol === 'SOL' || p.baseToken.symbol === 'USDC' || p.baseToken.symbol === 'USDC.s') {
                targetToken = p.quoteToken; // SOL is base, so target is quote
            } else {
                targetToken = p.baseToken; // SOL is quote, so target is base
            }

            // Simple validation to prevent errors
            if (!targetToken) return false;

            // Avoid buying same token twice
            const alreadyHolding = activeTrades.some(t => t.mint === targetToken.address);
            if (alreadyHolding) return false;

            const isSurvivor = (
                p.chainId === 'solana' &&
                liq >= CONFIG.MIN_LIQUIDITY_USD &&
                !CONFIG.BLACKLIST.includes(targetToken.symbol) &&
                !CONFIG.BLACKLIST.includes(p.baseToken.symbol) // Double check base for safety
            );

            return isSurvivor;
        });

        if (candidates.length === 0) {
            log("No valid candidates found fitting 'Survivor' criteria.", 'WAIT');
            return null;
        }

        // Sort by Volume (Momentum)
        candidates.sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0));
        
        // Pick a random candidate from the Top 3 to add variety (SOL vs Memes)
        const topN = candidates.slice(0, 3);
        const best = topN[Math.floor(Math.random() * topN.length)];
        
        log(`Target Found: ${best.baseToken.symbol} ($${best.priceUsd}) | Vol: $${best.volume.h1}`, 'TARGET');
        return best;

    } catch (e) {
        log(`Scan Error: ${e.message}`, 'ERR');
        return null;
    }
}

// --- TRADING ENGINE ---
async function manageTrades() {
    if (activeTrades.length === 0) return;

    // Process all trades in parallel
    await Promise.all(activeTrades.map(async (trade) => {
        const mint = trade.mint;
        let currentPrice = 0;
        
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
            const resp = await axios.get(url, { timeout: 5000 });
            
            if (!resp.data.pairs || resp.data.pairs.length === 0) {
                 log(`Price API returned no pairs for mint: ${mint}`, 'ERR');
                 return;
            }
            
            // Get price from the most liquid pair
            const bestPair = resp.data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            currentPrice = parseFloat(bestPair.priceUsd);
            
            log(`${trade.symbol}: $${currentPrice} (Mint: ${trade.mint})`, 'TICK');
            
        } catch (e) {
            log(`Price check failed for ${trade.symbol}: ${e.message}`, 'WARN');
            return;
        }

        if (!currentPrice) return;

        // Calc PnL
        const diff = currentPrice - trade.entryPrice;
        const pnlPercent = (diff / trade.entryPrice) * 100;
        
        // Update lastPrice for API stats
        trade.lastPrice = currentPrice;

        log(`${trade.symbol}: $${currentPrice} (PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`, 'TICK');

        // Decision Logic
        if (pnlPercent >= CONFIG.TAKE_PROFIT) {
            await executeSell(trade, currentPrice, "TAKE PROFIT");
        } else if (pnlPercent <= -CONFIG.STOP_LOSS) {
            await executeSell(trade, currentPrice, "STOP LOSS");
        }
    }));
}

async function executeBuy(target) {
    if (wallet.usd < CONFIG.BUY_AMOUNT_USD) {
        log("Wallet insufficient funds.", 'SKIP');
        return;
    }

    const price = parseFloat(target.priceUsd);
    const cost = CONFIG.BUY_AMOUNT_USD;
    const fee = CONFIG.SIM_FEE;
    const net = cost - fee;
    const tokens = net / price;

    wallet.usd -= cost;
    
    const newTrade = {
        mint: target.baseToken.address,
        symbol: target.baseToken.symbol,
        entryPrice: price,
        tokens: tokens,
        startTime: Date.now()
    };

    activeTrades.push(newTrade);

    log(`>>> BUY ${newTrade.symbol} @ $${price} (Mint: ${newTrade.mint})`, 'TRADE');
    log(`    Position: ${tokens.toFixed(2)} tokens`);
    log(`    Wallet: $${wallet.usd.toFixed(2)} (Active Trades: ${activeTrades.length})`, 'CONF');
}

async function executeSell(trade, price, reason) {
    const revenue = trade.tokens * price;
    const fee = CONFIG.SIM_FEE;
    const net = revenue - fee;
    const profit = net - CONFIG.BUY_AMOUNT_USD;
    const pnlPercent = ((price - trade.entryPrice) / trade.entryPrice) * 100;

    wallet.usd += net;
    
    log(`<<< SELL ${trade.symbol} @ $${price} (${reason})`, 'TRADE');
    log(`    Profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
    log(`    Wallet: $${wallet.usd.toFixed(2)}`);

    wallet.history.push({ 
        symbol: trade.symbol,
        mint: trade.mint,
        tokens: trade.tokens,
        entryPrice: trade.entryPrice,
        exitPrice: price,
        profit: profit, 
        reason: reason,
        startTime: trade.startTime,
        endTime: Date.now()
    });
    
    // Remove from active trades
    activeTrades = activeTrades.filter(t => t.mint !== trade.mint);
}

// --- MAIN LOOP ---
async function run() {
    log("--- HUNTER BOT STARTED ---", 'INIT');
    log(`Strategy: Multi-Slot Survivor Scalp (Liq > $${CONFIG.MIN_LIQUIDITY_USD}, Age > ${CONFIG.MIN_PAIR_AGE_HOURS}h)`, 'CONF');
    log(`Wallet: $${wallet.usd.toFixed(2)}`, 'CONF');

    // Run loops concurrently
    setInterval(async () => {
        const target = await scanForTarget();
        if (target) {
            await executeBuy(target);
        }
    }, CONFIG.SCAN_INTERVAL_MS);

    setInterval(async () => {
        await manageTrades();
    }, CONFIG.PRICE_CHECK_MS);
}

run();
