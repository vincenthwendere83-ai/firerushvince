// ============================================================
// SKYRUSH PRO - FIREBASE MASTER SERVER
// Precise RTP Control, House-Edge Protection & Cryptographic RNG
// ============================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const serviceAccount = require('./serviceAccountKey.json');

if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount),
        databaseURL: 'https://fireskyrush-5066b-default-rtdb.firebaseio.com'
    });
}

const db = getDatabase();
const gameStateRef = db.ref('skyrush_live_state');
const actionsRef = db.ref('skyrush_actions');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// GAME CONFIGURATION & LIMITS
// ============================================================

const DEFAULT_RTP = 95;
const MIN_RTP = 50;
const MAX_RTP = 99;
const MAX_ROUND_MULTIPLIER = 100.00;

const MIN_BET = 0.50;
const MAX_BET = 1.00;

const PLAYER_IDS = ['p1', 'p2', 'p3', 'p4'];

// ============================================================
// GAME STATE
// ============================================================

let gameState = {
    status: 'waiting',
    multiplier: 1.00,
    maxRoundMultiplier: 2.00,
    countdownSecs: 5.0,
    rtp: DEFAULT_RTP,
    volatility: 'medium',
    adminPass: 'admin123',
    history: [1.45, 2.10, 1.12, 5.40, 1.05],
    metrics: {
        totalBets: 0,
        totalPayouts: 0,
        totalWins: 0,
        netProfit: 0,
        totalDeposits: 4000,
        completedRounds: 0,
        observedRTP: 0.00,
        observedHouseEdge: 5.00,
        theoreticalRTP: DEFAULT_RTP
    },
    auditLog: [],
    players: {
        p1: { balance: 1000, status: 'idle', nextBet: 0, currentBet: 0, autoCash: false, autoVal: 2.00, winAmt: 0 },
        p2: { balance: 1000, status: 'idle', nextBet: 0, currentBet: 0, autoCash: false, autoVal: 2.00, winAmt: 0 },
        p3: { balance: 1000, status: 'idle', nextBet: 0, currentBet: 0, autoCash: false, autoVal: 2.00, winAmt: 0 },
        p4: { balance: 1000, status: 'idle', nextBet: 0, currentBet: 0, autoCash: false, autoVal: 2.00, winAmt: 0 }
    }
};

let flightInterval = null;
let countdownInterval = null;
let nextRoundTimeout = null;

function syncToFirebase() {
    gameStateRef.set(gameState).catch((err) => {
        console.error('Firebase Sync Error:', err.message);
    });
}

function logAudit(actionType, details) {
    const entry = {
        timestamp: new Date().toISOString(),
        action: actionType,
        details: details
    };
    gameState.auditLog.unshift(entry);
    if (gameState.auditLog.length > 50) gameState.auditLog.pop();
}

// ============================================================
// PRECISE RTP-SENSITIVE CRYPTOGRAPHIC RNG
// ============================================================

function generatePreciseRTPCrashPoint(rtp) {
    if (typeof rtp !== 'number' || !Number.isFinite(rtp) || rtp < MIN_RTP || rtp > MAX_RTP) {
        throw new Error('Invalid RTP configuration');
    }

    const bytes = crypto.randomBytes(7);
    const random52 = bytes.readUIntBE(0, 6) * 16 + (bytes[6] >> 4);
    const u = random52 / (2 ** 52);

    const theoreticalRTP = rtp / 100;

    const rawMultiplier = theoreticalRTP / (1 - u);
    const cappedMultiplier = Math.min(rawMultiplier, MAX_ROUND_MULTIPLIER);
    const crashPoint = Math.max(1.00, Math.floor(cappedMultiplier * 100) / 100);

    return Number(crashPoint.toFixed(2));
}

// ============================================================
// METRICS & HOUSE-EDGE ACCOUNTING
// ============================================================

function updateMetrics(stakeDelta, payoutDelta, isRoundComplete = false) {
    if (stakeDelta > 0) {
        gameState.metrics.totalBets = Math.round((gameState.metrics.totalBets + stakeDelta) * 100) / 100;
    }
    if (payoutDelta > 0) {
        gameState.metrics.totalPayouts = Math.round((gameState.metrics.totalPayouts + payoutDelta) * 100) / 100;
    }
    if (isRoundComplete) {
        gameState.metrics.completedRounds += 1;
    }

    const totalStakes = gameState.metrics.totalBets;
    const totalPayouts = gameState.metrics.totalPayouts;

    if (totalStakes > 0) {
        gameState.metrics.observedRTP = Number(((totalPayouts / totalStakes) * 100).toFixed(2));
        gameState.metrics.observedHouseEdge = Number((100 - gameState.metrics.observedRTP).toFixed(2));
    } else {
        gameState.metrics.observedRTP = 0.00;
        gameState.metrics.observedHouseEdge = Number((100 - gameState.rtp).toFixed(2));
    }

    gameState.metrics.theoreticalRTP = gameState.rtp;
}

// ============================================================
// GAME CONTROL LOOPS
// ============================================================

function startCountdown() {
    if (gameState.status === 'flying') return;
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (nextRoundTimeout) { clearTimeout(nextRoundTimeout); nextRoundTimeout = null; }

    gameState.status = 'waiting';
    gameState.countdownSecs = 5.0;
    syncToFirebase();

    countdownInterval = setInterval(() => {
        if (gameState.status !== 'waiting') {
            clearInterval(countdownInterval);
            countdownInterval = null;
            return;
        }

        gameState.countdownSecs = Math.max(0, Number((gameState.countdownSecs - 0.1).toFixed(1)));
        if (gameState.countdownSecs <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            startFlight();
        } else {
            syncToFirebase();
        }
    }, 100);
}

function startFlight() {
    if (gameState.status === 'flying') return;
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (nextRoundTimeout) { clearTimeout(nextRoundTimeout); nextRoundTimeout = null; }

    gameState.status = 'flying';
    gameState.multiplier = 1.00;
    gameState.roundRTP = gameState.rtp; 
    gameState.maxRoundMultiplier = generatePreciseRTPCrashPoint(gameState.roundRTP);

    let roundStakes = 0;
    PLAYER_IDS.forEach((id) => {
        const p = gameState.players[id];
        if (p && p.nextBet >= MIN_BET && p.nextBet <= MAX_BET && p.balance >= p.nextBet) {
            p.balance = Math.round((p.balance - p.nextBet) * 100) / 100;
            p.currentBet = p.nextBet;
            p.nextBet = 0;
            p.status = 'in_game';
            p.winAmt = 0;
            roundStakes += p.currentBet;
        } else {
            p.nextBet = 0;
            p.currentBet = 0;
            p.status = 'idle';
        }
    });

    updateMetrics(roundStakes, 0, false);
    syncToFirebase();

    if (flightInterval) { clearInterval(flightInterval); flightInterval = null; }

    // Smooth, trackable climb speed (150ms intervals with gentle increment)
    flightInterval = setInterval(() => {
        if (gameState.status !== 'flying') {
            clearInterval(flightInterval);
            flightInterval = null;
            return;
        }

        if (gameState.multiplier >= gameState.maxRoundMultiplier) {
            forceCrash();
            return;
        }

        gameState.multiplier = Number((gameState.multiplier + 0.01 + (gameState.multiplier * 0.02)).toFixed(2));

        PLAYER_IDS.forEach((id) => {
            const p = gameState.players[id];
            if (p && p.status === 'in_game' && p.autoCash && p.autoVal > 0 &&
                p.autoVal > (gameState.multiplier - 0.03) && p.autoVal <= gameState.multiplier && p.autoVal < gameState.maxRoundMultiplier) {
                
                const win = Math.round((p.currentBet * p.autoVal) * 100) / 100;
                p.balance = Math.round((p.balance + win) * 100) / 100;
                p.status = 'cashed_out';
                p.winAmt = win;
                gameState.metrics.totalWins = Math.round((gameState.metrics.totalWins + win) * 100) / 100;
                updateMetrics(0, win, false);
            }
        });

        syncToFirebase();
    }, 150);
}

function forceCrash() {
    if (flightInterval) { clearInterval(flightInterval); flightInterval = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (nextRoundTimeout) { clearTimeout(nextRoundTimeout); nextRoundTimeout = null; }

    gameState.status = 'crashed';
    gameState.multiplier = Number(gameState.maxRoundMultiplier.toFixed(2));

    if (!Array.isArray(gameState.history)) gameState.history = [];
    gameState.history.unshift(gameState.multiplier);
    if (gameState.history.length > 20) gameState.history.pop();

    let roundLostBets = 0;
    PLAYER_IDS.forEach((id) => {
        const p = gameState.players[id];
        if (p && p.status === 'in_game') {
            p.status = 'lost';
            roundLostBets += p.currentBet;
        }
    });

    gameState.metrics.netProfit = Math.round((gameState.metrics.netProfit + roundLostBets) * 100) / 100;
    updateMetrics(0, 0, true);
    syncToFirebase();

    nextRoundTimeout = setTimeout(() => {
        nextRoundTimeout = null;
        if (gameState.status === 'crashed') startCountdown();
    }, 4000);
}

// ============================================================
// ACTION & ADMIN LISTENER WITH SECURE VALIDATION
// ============================================================

actionsRef.on('child_added', async (snapshot) => {
    const action = snapshot.val();
    if (!action) {
        await snapshot.ref.remove().catch(() => {});
        return;
    }

    try {
        if (action.type === 'STATION_ACTION') {
            const { playerId, betVal, autoToggle, autoVal } = action;
            const p = gameState.players[playerId];
            if (p) {
                if (gameState.status === 'flying') {
                    if (p.status === 'in_game') {
                        const win = Math.round((p.currentBet * gameState.multiplier) * 100) / 100;
                        p.balance = Math.round((p.balance + win) * 100) / 100;
                        p.status = 'cashed_out';
                        p.winAmt = win;
                        gameState.metrics.totalWins = Math.round((gameState.metrics.totalWins + win) * 100) / 100;
                        updateMetrics(0, win, false);
                    }
                } else if (gameState.status === 'waiting') {
                    if (p.nextBet > 0 || p.status === 'queued') {
                        p.nextBet = 0;
                        p.status = 'idle';
                    } else if (betVal >= MIN_BET && betVal <= MAX_BET && p.balance >= betVal) {
                        p.nextBet = betVal;
                        p.status = 'queued';
                        p.autoCash = typeof autoToggle === 'boolean' ? autoToggle : false;
                        p.autoVal = typeof autoVal === 'number' ? autoVal : 2.00;
                    }
                }
                syncToFirebase();
            }
        } else if (action.type === 'ADMIN_ACTION') {
            const { subType, rtp, volatility, passkey, playerId, txType, amount } = action;

            if (subType === 'START_COUNTDOWN') {
                startCountdown();
            } else if (subType === 'START_FLIGHT') {
                startFlight();
            } else if (subType === 'FORCE_CRASH') {
                forceCrash();
            } else if (subType === 'UPDATE_RTP') {
                const parsedRTP = parseInt(rtp, 10);
                if (gameState.status === 'flying') {
                    console.warn('Blocked RTP change: Flight is currently active.');
                } else if (Number.isFinite(parsedRTP) && parsedRTP >= MIN_RTP && parsedRTP <= MAX_RTP) {
                    gameState.rtp = parsedRTP;
                    logAudit('UPDATE_RTP', { newRTP: parsedRTP });
                    syncToFirebase();
                } else {
                    console.warn(`Rejected out-of-range RTP input: ${rtp}`);
                }
            } else if (subType === 'UPDATE_VOLATILITY' && ['low', 'medium', 'high', 'extreme'].includes(volatility)) {
                gameState.volatility = volatility;
                logAudit('UPDATE_VOLATILITY', { volatility });
                syncToFirebase();
            } else if (subType === 'UPDATE_PASSKEY' && typeof passkey === 'string' && passkey.length >= 4 && passkey.length <= 128) {
                gameState.adminPass = passkey;
                logAudit('UPDATE_PASSKEY', { status: 'success' });
                syncToFirebase();
            } else if (subType === 'TRANSACT' && playerId && txType && amount) {
                const p = gameState.players[playerId];
                if (p && amount > 0 && amount <= 100000) {
                    if (txType === 'DEPOSIT') {
                        p.balance = Math.round((p.balance + amount) * 100) / 100;
                        gameState.metrics.totalDeposits = Math.round((gameState.metrics.totalDeposits + amount) * 100) / 100;
                        logAudit('TRANSACT_DEPOSIT', { playerId, amount });
                    } else if (txType === 'WITHDRAW') {
                        p.balance = Math.round((Math.max(0, p.balance - amount)) * 100) / 100;
                        logAudit('TRANSACT_WITHDRAW', { playerId, amount });
                    }
                    syncToFirebase();
                }
            }
        }
    } catch (err) {
        console.error('SkyRush action processing error:', err.message);
    } finally {
        await snapshot.ref.remove().catch(() => {});
    }
});

// ============================================================
// WEB ROUTES & BOOT
// ============================================================

app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/cashier', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cashier.html')));

app.get('/health', (req, res) => {
    res.json({
        status: 'active',
        game: 'SkyRush',
        gameStatus: gameState.status,
        metrics: gameState.metrics,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SkyRush RTP-Validated Master Server running on port ${PORT}`);
    startCountdown();
});
