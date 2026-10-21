'use strict';

// Watchlist of liquid coins the engine may trade. Derived from Binance's own
// liquid spot/futures pairs. Excludes illiquid/hype coins that can't be relied
// on for real analysis and that carry unacceptable manipulation risk.
//
// NOTE: for futures (USDT-M), the coin must have a 1000x or 1x multiplier in
// market info; ccxt resolves symbol name differences. Pair formatting here uses
// BASE/USDT for both spot (exchange.fetchOHLCV('BTC/USDT')) and futures
// (exchange.fetchOHLCV('BTC/USDT:USDT')).

const UNIVERSE = [
  { base: 'BTC',  name: 'Bitcoin' },
  { base: 'ETH',  name: 'Ethereum' },
  { base: 'BNB',  name: 'BNB' },
  { base: 'SOL',  name: 'Solana' },
  { base: 'XRP',  name: 'XRP' },
  { base: 'ADA',  name: 'Cardano' },
  { base: 'AVAX', name: 'Avalanche' },
  { base: 'DOGE', name: 'Dogecoin' },
  { base: 'DOT',  name: 'Polkadot' },
  { base: 'LINK', name: 'Chainlink' },
  { base: 'LTC',  name: 'Litecoin' },
  { base: 'UNI',  name: 'Uniswap' },
  { base: 'ATOM', name: 'Cosmos' },
  { base: 'XLM',  name: 'Stellar' },
  { base: 'NEAR', name: 'NEAR Protocol' },
  { base: 'ALGO', name: 'Algorand' },
  { base: 'VET',  name: 'VeChain' },
  { base: 'FIL',  name: 'Filecoin' },
  { base: 'ICP',  name: 'Internet Computer' },
  { base: 'APT',  name: 'Aptos' },
  { base: 'ARB',  name: 'Arbitrum' },
  { base: 'OP',   name: 'Optimism' },
  { base: 'SUI',  name: 'Sui' },
  { base: 'LDO',  name: 'Lido DAO' },
];

function spotSymbol(b) { return b + '/USDT'; }
function futSymbol(b) { return b + '/USDT:USDT'; }

module.exports = { UNIVERSE, spotSymbol, futSymbol };
