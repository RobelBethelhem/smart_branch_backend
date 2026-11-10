// Figures for the Branch Record dashboard (GET /zsmart_branch_requests/branch_transactions_stats).
//
// What the figures mean:
//  • A request moves money only when it is posted to FlexCube, so every AMOUNT counts completed
//    requests only (status posted, authorized or audited). Requests that are still waiting, were
//    never served or were rejected are counted on their own and never added to a money total.
//  • "Not served": a request that was not completed on the day it was made. It has the status
//    "expired" (utils/rms/requestExpiry.js), or is about to get it: still open on a later day.
//    The record itself is kept.
//  • A request belongs to the teller who posted it, or, while it is not posted, to the teller
//    it is assigned to.
//  • Amounts are added up in cents, so long sums do not pick up floating-point error.

const COMPLETED_STATUSES = new Set(['posted', 'authorized', 'audited']);
// Open statuses that expire at the end of the day of the request (same list as requestExpiry.js;
// not imported from there so this file stays free of database code and can be tested alone).
const EXPIRING_STATUSES = new Set(['requested', 'assigned', 'assigned_by_csr', 'delayed', 'pending_checker']);
// Money leaving the customer's account. ('other-bank-transfer' is the old spelling of the type.)
const OUTGOING_TYPES = new Set(['withdraw', 'echeck', 'other_bank_transfer', 'other-bank-transfer', 'air_ticket_payment']);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UNASSIGNED = 'Unassigned';

// Lightweight fields needed for the figures (no images or other heavy fields).
export const STATS_PROJECTION = {
    amount_in_figures: 1, status: 1, posted_by: 1, assigned_to: 1, beneficiary_branch: 1,
    assigned_date: 1, posted_date: 1, request_date: 1,
};

const toCents = (value) => {
    const amount = parseFloat(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
};
const fromCents = (cents) => cents / 100;

const minutesBetween = (later, earlier) => {
    if (!later || !earlier) return null;
    const minutes = (new Date(later) - new Date(earlier)) / 60000;
    return Number.isNaN(minutes) || minutes < 0 ? null : minutes;
};

// 'in', 'out' or null (a type this dashboard does not classify).
const moneyDirection = (type, beneficiaryBranch, branchCode) => {
    if (type === 'deposit') return 'in';
    if (OUTGOING_TYPES.has(type)) return 'out';
    if (type === 'transfer') return beneficiaryBranch === branchCode ? 'in' : 'out';
    return null;
};

const bucketOf = (status, requestDate, startOfToday) => {
    if (COMPLETED_STATUSES.has(status)) return 'completed';
    if (status === 'rejected') return 'rejected';
    if (status === 'expired') return 'notServed';
    if (EXPIRING_STATUSES.has(status) && requestDate && new Date(requestDate) < startOfToday) return 'notServed';
    return 'pending';
};

const newDuration = () => ({ min: Infinity, max: 0, total: 0, count: 0 });
const addDuration = (duration, minutes) => {
    if (minutes === null) return;
    duration.min = Math.min(duration.min, minutes);
    duration.max = Math.max(duration.max, minutes);
    duration.total += minutes;
    duration.count += 1;
};
const round1 = (value) => Math.round(value * 10) / 10;
const durationSummary = (duration) => (duration.count === 0
    ? { min: 0, max: 0, avg: 0, count: 0 }
    : { min: round1(duration.min), max: round1(duration.max), avg: round1(duration.total / duration.count), count: duration.count });

/**
 * @param {Array} transactions lean documents with STATS_PROJECTION fields plus `transactionType`
 * @param {string} branchCode  the branch the figures are for ('' = all branches)
 * @param {Date} [now]         only passed by tests
 */
export const computeBranchStats = (transactions, branchCode, now = new Date()) => {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const counts = { completed: 0, pending: 0, notServed: 0, rejected: 0 };
    const cents = { completed: 0, pending: 0, notServed: 0, rejected: 0, incoming: 0, outgoing: 0 };
    let maxCents = 0;
    let minCents = Infinity;

    const transactionTypes = {};
    const statusDistribution = {};
    const postedByDistribution = {};
    const userStats = {};
    const delayByUser = {};
    const tellers = new Map();
    const waitingTimes = [];
    const turnaround = newDuration();
    const hourSlots = {};
    const dayCounts = {};
    // Work that has left the teller but is not finished, and how much of it is from earlier days.
    const awaitingAuthorization = { count: 0, olderThanToday: 0 };
    const awaitingAudit = { count: 0, olderThanToday: 0 };

    const tellerRow = (name) => {
        if (!tellers.has(name)) {
            tellers.set(name, {
                teller: name, total: 0, completed: 0, pending: 0, notServed: 0, rejected: 0,
                awaitingAuthorization: 0, incomingCents: 0, outgoingCents: 0, handling: newDuration(),
            });
        }
        return tellers.get(name);
    };

    transactions.forEach((tx) => {
        const amountCents = toCents(tx.amount_in_figures);
        const type = tx.transactionType ? tx.transactionType.toLowerCase() : undefined;
        const status = tx.status || 'unknown';
        const postedBy = tx.posted_by || UNASSIGNED;
        const bucket = bucketOf(status, tx.request_date, startOfToday);
        const isCompleted = bucket === 'completed';
        const direction = isCompleted ? moneyDirection(type, tx.beneficiary_branch || '', branchCode) : null;

        transactionTypes[type] = (transactionTypes[type] || 0) + 1;
        statusDistribution[status] = (statusDistribution[status] || 0) + 1;
        postedByDistribution[postedBy] = (postedByDistribution[postedBy] || 0) + 1;

        counts[bucket] += 1;
        cents[bucket] += amountCents;
        if (direction === 'in') cents.incoming += amountCents;
        if (direction === 'out') cents.outgoing += amountCents;
        if (isCompleted) {
            if (amountCents > maxCents) maxCents = amountCents;
            if (amountCents < minCents) minCents = amountCents;
        }

        const isOlderThanToday = tx.request_date && new Date(tx.request_date) < startOfToday;
        if (status === 'posted') {
            awaitingAuthorization.count += 1;
            if (isOlderThanToday) awaitingAuthorization.olderThanToday += 1;
        } else if (status === 'authorized') {
            awaitingAudit.count += 1;
            if (isOlderThanToday) awaitingAudit.olderThanToday += 1;
        }

        // Charts keyed by the user who posted.
        if (!userStats[postedBy]) userStats[postedBy] = { incomingMoney: 0, outgoingMoney: 0, count: 0 };
        userStats[postedBy].count += 1;
        if (direction === 'in') userStats[postedBy].incomingMoney += amountCents;
        if (direction === 'out') userStats[postedBy].outgoingMoney += amountCents;

        // Time the teller took: assigned -> posted.
        const handlingMinutes = isCompleted ? minutesBetween(tx.posted_date, tx.assigned_date) : null;
        if (handlingMinutes !== null) {
            if (!delayByUser[postedBy]) delayByUser[postedBy] = newDuration();
            addDuration(delayByUser[postedBy], handlingMinutes);
        }

        // Per-teller detail.
        const row = tellerRow((isCompleted ? (tx.posted_by || tx.assigned_to) : tx.assigned_to) || UNASSIGNED);
        row.total += 1;
        row[bucket] += 1;
        if (status === 'posted') row.awaitingAuthorization += 1;
        if (direction === 'in') row.incomingCents += amountCents;
        if (direction === 'out') row.outgoingCents += amountCents;
        addDuration(row.handling, handlingMinutes);

        // Time until a teller took the request: request -> assigned, whole minutes.
        const waitMinutes = minutesBetween(tx.assigned_date, tx.request_date);
        if (waitMinutes !== null) waitingTimes.push(Math.round(waitMinutes));

        // Time the customer waited in total: request -> posted.
        if (isCompleted) addDuration(turnaround, minutesBetween(tx.posted_date, tx.request_date));

        // Busy hours (2-hour windows) and busy days, by the time of the request.
        if (tx.request_date) {
            const d = new Date(tx.request_date);
            const slotStart = Math.floor(d.getHours() / 2) * 2;
            const label = `${String(slotStart).padStart(2, '0')}:00 - ${String(slotStart + 2).padStart(2, '0')}:00`;
            hourSlots[label] = (hourSlots[label] || 0) + 1;
            const day = WEEKDAYS[d.getDay()];
            if (day) dayCounts[day] = (dayCounts[day] || 0) + 1;
        }
    });

    Object.values(userStats).forEach((stats) => {
        stats.incomingMoney = fromCents(stats.incomingMoney);
        stats.outgoingMoney = fromCents(stats.outgoingMoney);
    });

    const delayMetrics = {};
    Object.entries(delayByUser).forEach(([user, duration]) => {
        delayMetrics[user] = { min: duration.min, max: duration.max, avg: duration.total / duration.count };
    });

    let waitStats = { min: 0, max: 0, avg: 0 };
    if (waitingTimes.length > 0) {
        waitStats = {
            min: waitingTimes.reduce((m, v) => (v < m ? v : m), Infinity),
            max: waitingTimes.reduce((m, v) => (v > m ? v : m), -Infinity),
            avg: (waitingTimes.reduce((a, b) => a + b, 0) / waitingTimes.length).toFixed(1),
        };
    }

    const tellerStats = [...tellers.values()]
        .map(({ incomingCents, outgoingCents, handling, ...row }) => ({
            ...row,
            incomingMoney: fromCents(incomingCents),
            outgoingMoney: fromCents(outgoingCents),
            completedAmount: fromCents(incomingCents + outgoingCents),
            handlingMinutes: durationSummary(handling),
        }))
        // Busiest first; "Unassigned" (requests no teller has taken) always last.
        .sort((a, b) => (a.teller === UNASSIGNED) - (b.teller === UNASSIGNED)
            || b.completed - a.completed || b.total - a.total || a.teller.localeCompare(b.teller));

    const incomingMoney = fromCents(cents.incoming);
    const outgoingMoney = fromCents(cents.outgoing);
    const totalAmount = fromCents(cents.completed);

    return {
        asOf: now.toISOString(),
        totalTransactions: transactions.length,
        // How the requests ended up, and the money value of each group.
        completedCount: counts.completed,
        pendingCount: counts.pending,
        notServedCount: counts.notServed,
        rejectedCount: counts.rejected,
        pendingAmount: fromCents(cents.pending),
        notServedAmount: fromCents(cents.notServed),
        rejectedAmount: fromCents(cents.rejected),
        awaitingAuthorization,
        awaitingAudit,
        // Money (completed requests only).
        incomingMoney, outgoingMoney, netFlow: fromCents(cents.incoming - cents.outgoing),
        incomingAmount: incomingMoney, outgoingAmount: outgoingMoney,
        totalAmount,
        maxAmount: fromCents(maxCents),
        minAmount: minCents === Infinity ? 0 : fromCents(minCents),
        avgAmount: counts.completed > 0 ? fromCents(Math.round(cents.completed / counts.completed)) : 0,
        // Breakdowns.
        transactionTypes, typeCounts: transactionTypes,
        statusDistribution, statusCounts: statusDistribution,
        postedByDistribution, userStats, delayMetrics, tellerStats,
        // Time.
        waitStats, turnaroundStats: durationSummary(turnaround),
        hourSlots, dayCounts,
    };
};
