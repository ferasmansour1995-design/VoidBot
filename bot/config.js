// Void Protocol Configuration
require('dotenv').config();

// FALBACK: If no env var is set, use this Helius key directly
const HARDCODED_RPC = 'https://mainnet.helius-rpc.com/?api-key=859c8449-6d29-4cbc-a267-18e055abe2c1';
const HARDCODED_WSS = 'wss://mainnet.helius-rpc.com/?api-key=859c8449-6d29-4cbc-a267-18e055abe2c1';

module.exports = {
  // Network
  RPC_URL: process.env.RPC_URL || HARDCODED_RPC,
  WSS_URL: process.env.WSS_URL || HARDCODED_WSS,
  
  // Strategy: The Void Protocol (Paper Mode)
  STRATEGY: {
    minLiquiditySOL: 10,     // Minimum LP to consider (avoid dust)
    maxLiquiditySOL: 500,    // Max LP (avoid established pairs, we want fresh)
    buyAmountSOL: 0.1,       // Paper trade size (approx $15-20)
    takeProfitMultiplier: 2, // Sell 50% at 2x
    stopLossPercent: 0.40,   // Stop loss at -40%
    moonbagPercent: 0.50     // Amount to hold after TP1
  },

  // Raydium Program ID (Liquidity Pool V4)
  RAYDIUM_PUBLIC_KEY: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
};