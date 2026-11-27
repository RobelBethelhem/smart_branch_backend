// The sections Customer 360 starts with. Each has demo rows (what the page shows until the
// section is switched to "Live") and a sample query that returns rows of the same shape.
//
// The sample queries use the FlexCube tables this system already reads (STTM_CUSTOMER,
// STTM_CUST_PERSONAL, STTM_CUST_ACCOUNT, STTM_ACCOUNT_BALANCE, ACVWS_ALL_AC_ENTRIES). They have
// NOT been run against FlexCube: have the FlexCube team check each one before it goes live.
// The demo rows are invented and belong to no customer.

const SAMPLE_NOTE = "-- Sample. Run it for a customer and check the result with the FlexCube team before switching this section to Live.\n";

export const DEFAULT_SECTIONS = [
    {
        key: "profile",
        title: "Customer",
        type: "profile",
        placement: "side",
        width: 12,
        order: 10,
        demo_rows: [{ NAME: "", CIF: "", SINCE: "Mar 2014", SEGMENT: "Priority · VIP", KYC_STATUS: "KYC verified", PHOTO: "" }],
        query: `${SAMPLE_NOTE}SELECT * FROM (
  SELECT c.CUSTOMER_NAME1                          AS NAME,
         c.CUSTOMER_NO                             AS CIF,
         TO_CHAR(c.CIF_CREATION_DATE, 'Mon YYYY')  AS SINCE,
         c.CUSTOMER_CATEGORY                       AS SEGMENT,
         CASE WHEN c.RECORD_STAT = 'O' THEN 'Active customer' ELSE 'Closed' END AS KYC_STATUS,
         i.IMAGE_TEXT                              AS PHOTO
  FROM   FCUBSPRD.STTM_CUSTOMER c
  LEFT JOIN FCUBSPRD.STTM_CUST_IMAGE i ON i.CUSTOMER_NO = c.CUSTOMER_NO
  WHERE  c.CUSTOMER_NO = :cif
) WHERE ROWNUM = 1`,
        options: {},
    },
    {
        key: "personal_details",
        title: "Personal details",
        type: "details",
        placement: "side",
        width: 12,
        order: 20,
        demo_rows: [
            { LABEL: "Age · Occupation", VALUE: "41 · Business owner · Import & Export", SENSITIVE: "N" },
            { LABEL: "Phone", VALUE: "+251 91 555 0121", SENSITIVE: "Y" },
            { LABEL: "Email", VALUE: "selam@example.com", SENSITIVE: "Y" },
            { LABEL: "National ID", VALUE: "FAN 0000 0000 8842", SENSITIVE: "Y" },
            { LABEL: "Language", VALUE: "Amharic · English", SENSITIVE: "N" },
            { LABEL: "Preferred channel", VALUE: "Mobile app + branch", SENSITIVE: "N" },
            { LABEL: "Relationship manager", VALUE: "Hana Bekele · Priority desk", SENSITIVE: "N" },
            { LABEL: "Home branch", VALUE: "Central Branch", SENSITIVE: "N" },
        ],
        query: `${SAMPLE_NOTE}SELECT 'Date of birth' AS LABEL, TO_CHAR(p.DATE_OF_BIRTH, 'DD Mon YYYY') AS VALUE, 'N' AS SENSITIVE
FROM   FCUBSPRD.STTM_CUST_PERSONAL p WHERE p.CUSTOMER_NO = :cif
UNION ALL
SELECT 'Phone', p.MOBILE_NUMBER, 'Y'
FROM   FCUBSPRD.STTM_CUST_PERSONAL p WHERE p.CUSTOMER_NO = :cif
UNION ALL
SELECT 'Email', p.E_MAIL, 'Y'
FROM   FCUBSPRD.STTM_CUST_PERSONAL p WHERE p.CUSTOMER_NO = :cif
UNION ALL
SELECT 'National ID', c.UNIQUE_ID_VALUE, 'Y'
FROM   FCUBSPRD.STTM_CUSTOMER c WHERE c.CUSTOMER_NO = :cif
UNION ALL
SELECT 'Home branch', c.LOCAL_BRANCH, 'N'
FROM   FCUBSPRD.STTM_CUSTOMER c WHERE c.CUSTOMER_NO = :cif`,
        options: {},
    },
    {
        key: "relationship_summary",
        title: "Relationship summary",
        type: "text",
        placement: "side",
        width: 12,
        order: 30,
        demo_rows: [
            { TEXT: "Long-standing Priority customer with a salary, business and term-deposit relationship. Balances have grown steadily for 12 months and every repayment on the business term loan has been on time." },
            { TEXT: "A fixed deposit of ETB 2,100,000 matures in 9 days, which makes this the best moment to talk about renewal and the pre-approved overdraft." },
        ],
        query: `${SAMPLE_NOTE}SELECT 'Customer since ' || TO_CHAR(c.CIF_CREATION_DATE, 'Mon YYYY')
       || ' with ' || COUNT(a.CUST_AC_NO) || ' account(s) and a total available balance of ETB '
       || TO_CHAR(NVL(SUM(b.ACY_WITHDRAWABLE_BAL), 0), 'FM999,999,999,990.00') || '.' AS TEXT
FROM   FCUBSPRD.STTM_CUSTOMER c
LEFT JOIN FCUBSPRD.STTM_CUST_ACCOUNT a    ON a.CUST_NO = c.CUSTOMER_NO
LEFT JOIN FCUBSPRD.STTM_ACCOUNT_BALANCE b ON b.CUST_AC_NO = a.CUST_AC_NO
WHERE  c.CUSTOMER_NO = :cif
GROUP BY c.CIF_CREATION_DATE`,
        options: {},
    },
    {
        key: "highlights",
        title: "Highlights",
        type: "chips",
        placement: "main",
        width: 12,
        order: 40,
        demo_rows: [
            { TEXT: "Fixed deposit of ETB 2,100,000 matures in 9 days", TONE: "warn" },
            { TEXT: "Pre-approved business overdraft available", TONE: "good" },
            { TEXT: "KYC valid until Mar 2027", TONE: "info" },
        ],
        query: `${SAMPLE_NOTE}SELECT 'Account ending ' || SUBSTR(a.CUST_AC_NO, -4) || ' is dormant' AS TEXT, 'warn' AS TONE
FROM   FCUBSPRD.STTM_CUST_ACCOUNT a
WHERE  a.CUST_NO = :cif AND a.AC_STAT_DORMANT = 'Y'
UNION ALL
SELECT 'Account ending ' || SUBSTR(a.CUST_AC_NO, -4) || ' is blocked for debit', 'bad'
FROM   FCUBSPRD.STTM_CUST_ACCOUNT a
WHERE  a.CUST_NO = :cif AND a.AC_STAT_NO_DR = 'Y'`,
        options: {},
    },
    {
        key: "key_figures",
        title: "Key figures",
        type: "stats",
        placement: "main",
        width: 12,
        order: 50,
        demo_rows: [
            { LABEL: "Relationship value", VALUE: 8420000, PREFIX: "ETB", SUBTEXT: "Deposits + loans", TREND: "" },
            { LABEL: "Total deposits", VALUE: 6120000, PREFIX: "ETB", SUBTEXT: "3 accounts", TREND: "" },
            { LABEL: "Loans outstanding", VALUE: 2300000, PREFIX: "ETB", SUBTEXT: "1 facility · On time", TREND: "" },
            { LABEL: "Avg balance · 3M", VALUE: 6000000, PREFIX: "ETB", SUBTEXT: "", TREND: "+9.4% vs prior 3M" },
            { LABEL: "Products held", VALUE: "7", PREFIX: "", SUBTEXT: "of 9 · 2 gaps", TREND: "" },
            { LABEL: "Share of wallet", VALUE: "74%", PREFIX: "", SUBTEXT: "Primary bank", TREND: "" },
        ],
        query: `${SAMPLE_NOTE}SELECT 'Total deposits' AS LABEL, NVL(SUM(b.ACY_WITHDRAWABLE_BAL), 0) AS VALUE, 'ETB' AS PREFIX,
       COUNT(*) || ' account(s)' AS SUBTEXT, NULL AS TREND
FROM   FCUBSPRD.STTM_CUST_ACCOUNT a
JOIN   FCUBSPRD.STTM_ACCOUNT_BALANCE b ON b.CUST_AC_NO = a.CUST_AC_NO
WHERE  a.CUST_NO = :cif
UNION ALL
SELECT 'Blocked amount', NVL(SUM(b.ACY_BLOCKED_AMT), 0), 'ETB', NULL, NULL
FROM   FCUBSPRD.STTM_CUST_ACCOUNT a
JOIN   FCUBSPRD.STTM_ACCOUNT_BALANCE b ON b.CUST_AC_NO = a.CUST_AC_NO
WHERE  a.CUST_NO = :cif
UNION ALL
SELECT 'Accounts held', COUNT(*), NULL, 'all currencies', NULL
FROM   FCUBSPRD.STTM_CUST_ACCOUNT a
WHERE  a.CUST_NO = :cif`,
        options: {},
    },
    {
        key: "customer_scores",
        title: "Customer scores",
        type: "gauges",
        placement: "main",
        width: 5,
        order: 60,
        demo_rows: [
            { LABEL: "Relationship health", VALUE: 86, MAX: 100, DISPLAY: "86", CAPTION: "Healthy", TONE: "good" },
            { LABEL: "Churn risk", VALUE: 11, MAX: 100, DISPLAY: "11%", CAPTION: "Low risk", TONE: "good" },
            { LABEL: "Credit score", VALUE: 782, MAX: 850, DISPLAY: "782", CAPTION: "A · Excellent", TONE: "good" },
            { LABEL: "Satisfaction", VALUE: 9.2, MAX: 10, DISPLAY: "9.2", CAPTION: "Delighted", TONE: "good" },
        ],
        query: `-- Sample only. FlexCube does not keep these scores: point this query at the table where
-- the bank stores them (the table and column names below are placeholders).
SELECT s.SCORE_NAME AS LABEL, s.SCORE_VALUE AS VALUE, s.SCORE_MAX AS MAX,
       NULL AS DISPLAY, s.SCORE_BAND AS CAPTION, 'good' AS TONE
FROM   ANALYTICS.CUSTOMER_SCORES s
WHERE  s.CUSTOMER_NO = :cif
ORDER BY s.DISPLAY_ORDER`,
        options: {},
    },
    {
        key: "balance_trend",
        title: "Total balance trend",
        type: "line",
        placement: "main",
        width: 7,
        order: 70,
        demo_rows: [
            { LABEL: "Oct", VALUE: 4610000 }, { LABEL: "Nov", VALUE: 4680000 }, { LABEL: "Dec", VALUE: 4790000 },
            { LABEL: "Jan", VALUE: 4880000 }, { LABEL: "Feb", VALUE: 5010000 }, { LABEL: "Mar", VALUE: 5120000 },
            { LABEL: "Apr", VALUE: 5190000 }, { LABEL: "May", VALUE: 5240000 }, { LABEL: "Jun", VALUE: 5560000 },
            { LABEL: "Jul", VALUE: 5810000 }, { LABEL: "Aug", VALUE: 5960000 }, { LABEL: "Sep", VALUE: 6120000 },
        ],
        query: `${SAMPLE_NOTE}-- Net movement per month of the account the customer came for (money in minus money out).
SELECT TO_CHAR(TRUNC(e.TRN_DT, 'MM'), 'Mon') AS LABEL,
       SUM(CASE WHEN e.DRCR_IND = 'C' THEN e.LCY_AMOUNT ELSE -e.LCY_AMOUNT END) AS VALUE
FROM   FCUBSPRD.ACVWS_ALL_AC_ENTRIES e
WHERE  e.AC_NO = :account_number
AND    e.TRN_DT >= ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -11)
GROUP BY TRUNC(e.TRN_DT, 'MM')
ORDER BY TRUNC(e.TRN_DT, 'MM')`,
        options: { prefix: "ETB", badge: "+33% · 12M" },
    },
    {
        key: "cash_flow",
        title: "Cash flow · 6 months",
        type: "bars",
        placement: "main",
        width: 7,
        order: 80,
        demo_rows: [
            { LABEL: "Apr", VALUE_IN: 780000, VALUE_OUT: 560000 }, { LABEL: "May", VALUE_IN: 690000, VALUE_OUT: 640000 },
            { LABEL: "Jun", VALUE_IN: 910000, VALUE_OUT: 580000 }, { LABEL: "Jul", VALUE_IN: 1120000, VALUE_OUT: 870000 },
            { LABEL: "Aug", VALUE_IN: 850000, VALUE_OUT: 660000 }, { LABEL: "Sep", VALUE_IN: 960000, VALUE_OUT: 720000 },
        ],
        query: `${SAMPLE_NOTE}SELECT TO_CHAR(TRUNC(e.TRN_DT, 'MM'), 'Mon') AS LABEL,
       SUM(CASE WHEN e.DRCR_IND = 'C' THEN e.LCY_AMOUNT ELSE 0 END) AS VALUE_IN,
       SUM(CASE WHEN e.DRCR_IND = 'D' THEN e.LCY_AMOUNT ELSE 0 END) AS VALUE_OUT
FROM   FCUBSPRD.ACVWS_ALL_AC_ENTRIES e
WHERE  e.AC_NO = :account_number
AND    e.TRN_DT >= ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -5)
GROUP BY TRUNC(e.TRN_DT, 'MM')
ORDER BY TRUNC(e.TRN_DT, 'MM')`,
        options: { prefix: "ETB", label_in: "Money in", label_out: "Money out" },
    },
    {
        key: "channel_usage",
        title: "Channel usage",
        type: "donut",
        placement: "main",
        width: 5,
        order: 90,
        demo_rows: [
            { LABEL: "Mobile app", VALUE: 38, HIGHLIGHT: "Y", NOTE: "Digital-first, and branch visits are stable. Comes in mainly for cash-heavy business deposits." },
            { LABEL: "ATM", VALUE: 20, HIGHLIGHT: "N", NOTE: "" },
            { LABEL: "POS", VALUE: 17, HIGHLIGHT: "Y", NOTE: "" },
            { LABEL: "Online", VALUE: 12, HIGHLIGHT: "N", NOTE: "" },
            { LABEL: "Branch", VALUE: 8, HIGHLIGHT: "N", NOTE: "" },
            { LABEL: "Other", VALUE: 5, HIGHLIGHT: "N", NOTE: "" },
        ],
        query: `${SAMPLE_NOTE}-- Number of entries per kind of transaction in the last six months.
SELECT t.TRN_DESC AS LABEL, COUNT(*) AS VALUE, 'N' AS HIGHLIGHT, NULL AS NOTE
FROM   FCUBSPRD.ACVWS_ALL_AC_ENTRIES e
JOIN   FCUBSPRD.STTMS_TRN_CODE t ON t.TRN_CODE = e.TRN_CODE
WHERE  e.AC_NO = :account_number
AND    e.TRN_DT >= ADD_MONTHS(SYSDATE, -6)
GROUP BY t.TRN_DESC
ORDER BY COUNT(*) DESC`,
        options: { center_label: "digital" },
    },
];

// A starting point for a section the Super Admin adds, per kind of section.
export const SAMPLE_QUERY_BY_TYPE = {
    profile: DEFAULT_SECTIONS[0].query,
    details: DEFAULT_SECTIONS[1].query,
    text: DEFAULT_SECTIONS[2].query,
    chips: DEFAULT_SECTIONS[3].query,
    stats: DEFAULT_SECTIONS[4].query,
    gauges: DEFAULT_SECTIONS[5].query,
    line: DEFAULT_SECTIONS[6].query,
    bars: DEFAULT_SECTIONS[7].query,
    donut: DEFAULT_SECTIONS[8].query,
    table: `${SAMPLE_NOTE}SELECT a.CUST_AC_NO AS "Account", a.AC_DESC AS "Name", a.CCY AS "Currency",
       b.ACY_WITHDRAWABLE_BAL AS "Available balance"
FROM   FCUBSPRD.STTM_CUST_ACCOUNT a
JOIN   FCUBSPRD.STTM_ACCOUNT_BALANCE b ON b.CUST_AC_NO = a.CUST_AC_NO
WHERE  a.CUST_NO = :cif
ORDER BY a.CUST_AC_NO`,
};

export const SAMPLE_ROWS_BY_TYPE = {
    profile: DEFAULT_SECTIONS[0].demo_rows,
    details: DEFAULT_SECTIONS[1].demo_rows,
    text: DEFAULT_SECTIONS[2].demo_rows,
    chips: DEFAULT_SECTIONS[3].demo_rows,
    stats: DEFAULT_SECTIONS[4].demo_rows,
    gauges: DEFAULT_SECTIONS[5].demo_rows,
    line: DEFAULT_SECTIONS[6].demo_rows,
    bars: DEFAULT_SECTIONS[7].demo_rows,
    donut: DEFAULT_SECTIONS[8].demo_rows,
    table: [
        { Account: "1031110000000101", Name: "Saving Account", Currency: "ETB", "Available balance": 3120000 },
        { Account: "1031110000000102", Name: "Current Account", Currency: "ETB", "Available balance": 900000 },
    ],
};
