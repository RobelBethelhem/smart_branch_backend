import express from "express";
import CustomerCategoryLimit from "../../models/rms/CustomerCategoryLimit.js";
import MakerCheckerThreshold from "../../models/rms/MakerCheckerThreshold.js";
import { executeQuery } from "../../lib/db.js";
import auth from "../../middleware/rms/auth.js";
import roleCheck from "../../middleware/rms/roleCheck.js";

const router = express.Router();

// ============================================
// CUSTOMER CATEGORY LIMIT ENDPOINTS
// ============================================

/**
 * GET /customer-category-limits
 * Get all customer category limits
 */
router.get("/customer-category-limits", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const limits = await CustomerCategoryLimit.find()
            .sort({ customer_category: 1 });

        res.status(200).json({
            error: false,
            message: "Customer category limits fetched successfully",
            data: limits,
        });
    } catch (error) {
        console.error("Error fetching customer category limits:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to fetch customer category limits",
        });
    }
});

/**
 * GET /customer-category-limits/:id
 * Get a single customer category limit by ID
 */
router.get("/customer-category-limits/:id", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const limit = await CustomerCategoryLimit.findById(req.params.id);

        if (!limit) {
            return res.status(404).json({
                error: true,
                message: "Customer category limit not found",
            });
        }

        res.status(200).json({
            error: false,
            message: "Customer category limit fetched successfully",
            data: limit,
        });
    } catch (error) {
        console.error("Error fetching customer category limit:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to fetch customer category limit",
        });
    }
});

/**
 * POST /customer-category-limits
 * Create a new customer category limit
 */
router.post("/customer-category-limits", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const { customer_category, daily_limit, currency, created_by, created_by_id } = req.body;

        // Validate required fields
        if (!customer_category || daily_limit === undefined || daily_limit === null) {
            return res.status(400).json({
                error: true,
                message: "Customer category and daily limit are required",
            });
        }

        // Check if category already exists
        const existingLimit = await CustomerCategoryLimit.findOne({ customer_category });
        if (existingLimit) {
            return res.status(400).json({
                error: true,
                message: `Limit for customer category '${customer_category}' already exists`,
            });
        }

        const newLimit = new CustomerCategoryLimit({
            customer_category,
            daily_limit: parseFloat(daily_limit),
            currency: currency || 'ETB',
            created_by,
            created_by_id,
            updated_by: created_by,
            updated_by_id: created_by_id,
        });

        await newLimit.save();

        res.status(201).json({
            error: false,
            message: "Customer category limit created successfully",
            data: newLimit,
        });
    } catch (error) {
        console.error("Error creating customer category limit:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to create customer category limit",
        });
    }
});

/**
 * PUT /customer-category-limits/:id
 * Update a customer category limit
 */
router.put("/customer-category-limits/:id", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const { customer_category, daily_limit, currency, is_active, updated_by, updated_by_id } = req.body;

        const limit = await CustomerCategoryLimit.findById(req.params.id);

        if (!limit) {
            return res.status(404).json({
                error: true,
                message: "Customer category limit not found",
            });
        }

        // Check if new category name already exists (if changing)
        if (customer_category && customer_category !== limit.customer_category) {
            const existingLimit = await CustomerCategoryLimit.findOne({ customer_category });
            if (existingLimit) {
                return res.status(400).json({
                    error: true,
                    message: `Limit for customer category '${customer_category}' already exists`,
                });
            }
        }

        // Update fields
        if (customer_category) limit.customer_category = customer_category;
        if (daily_limit !== undefined && daily_limit !== null) limit.daily_limit = parseFloat(daily_limit);
        if (currency) limit.currency = currency;
        if (is_active !== undefined) limit.is_active = is_active;
        if (updated_by) limit.updated_by = updated_by;
        if (updated_by_id) limit.updated_by_id = updated_by_id;

        await limit.save();

        res.status(200).json({
            error: false,
            message: "Customer category limit updated successfully",
            data: limit,
        });
    } catch (error) {
        console.error("Error updating customer category limit:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to update customer category limit",
        });
    }
});

/**
 * DELETE /customer-category-limits/:id
 * Delete a customer category limit
 */
router.delete("/customer-category-limits/:id", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const limit = await CustomerCategoryLimit.findByIdAndDelete(req.params.id);

        if (!limit) {
            return res.status(404).json({
                error: true,
                message: "Customer category limit not found",
            });
        }

        res.status(200).json({
            error: false,
            message: "Customer category limit deleted successfully",
            data: limit,
        });
    } catch (error) {
        console.error("Error deleting customer category limit:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to delete customer category limit",
        });
    }
});

// ============================================
// MAKER CHECKER THRESHOLD ENDPOINTS
// ============================================

/**
 * GET /maker-checker-threshold
 * Get the current maker-checker threshold (returns the active one)
 */
router.get("/maker-checker-threshold", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        // Get the active threshold (there should only be one)
        let threshold = await MakerCheckerThreshold.findOne({ is_active: true });

        // If no threshold exists, return a default value
        if (!threshold) {
            res.status(200).json({
                error: false,
                message: "No maker-checker threshold configured",
                data: {
                    threshold_amount: 0,
                    currency: 'ETB',
                    is_active: false,
                    description: 'No threshold configured - all transactions require checker approval'
                },
            });
            return;
        }

        res.status(200).json({
            error: false,
            message: "Maker-checker threshold fetched successfully",
            data: threshold,
        });
    } catch (error) {
        console.error("Error fetching maker-checker threshold:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to fetch maker-checker threshold",
        });
    }
});

/**
 * POST /maker-checker-threshold
 * Create or update the maker-checker threshold
 */
router.post("/maker-checker-threshold", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const { threshold_amount, currency, description, created_by, created_by_id } = req.body;

        // Validate required fields
        if (threshold_amount === undefined || threshold_amount === null) {
            return res.status(400).json({
                error: true,
                message: "Threshold amount is required",
            });
        }

        // Deactivate any existing thresholds
        await MakerCheckerThreshold.updateMany({}, { is_active: false });

        // Create new threshold
        const newThreshold = new MakerCheckerThreshold({
            threshold_amount: parseFloat(threshold_amount),
            currency: currency || 'ETB',
            description: description || 'Transactions greater than or equal to this amount require checker approval',
            is_active: true,
            created_by,
            created_by_id,
            updated_by: created_by,
            updated_by_id: created_by_id,
        });

        await newThreshold.save();

        res.status(201).json({
            error: false,
            message: "Maker-checker threshold saved successfully",
            data: newThreshold,
        });
    } catch (error) {
        console.error("Error saving maker-checker threshold:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to save maker-checker threshold",
        });
    }
});

/**
 * PUT /maker-checker-threshold/:id
 * Update an existing maker-checker threshold
 */
router.put("/maker-checker-threshold/:id", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const { threshold_amount, currency, description, is_active, updated_by, updated_by_id } = req.body;

        const threshold = await MakerCheckerThreshold.findById(req.params.id);

        if (!threshold) {
            return res.status(404).json({
                error: true,
                message: "Maker-checker threshold not found",
            });
        }

        // If activating this threshold, deactivate others
        if (is_active) {
            await MakerCheckerThreshold.updateMany(
                { _id: { $ne: req.params.id } },
                { is_active: false }
            );
        }

        // Update fields
        if (threshold_amount !== undefined && threshold_amount !== null) {
            threshold.threshold_amount = parseFloat(threshold_amount);
        }
        if (currency) threshold.currency = currency;
        if (description) threshold.description = description;
        if (is_active !== undefined) threshold.is_active = is_active;
        if (updated_by) threshold.updated_by = updated_by;
        if (updated_by_id) threshold.updated_by_id = updated_by_id;

        await threshold.save();

        res.status(200).json({
            error: false,
            message: "Maker-checker threshold updated successfully",
            data: threshold,
        });
    } catch (error) {
        console.error("Error updating maker-checker threshold:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to update maker-checker threshold",
        });
    }
});

// ============================================
// FLEXCUBE CUSTOMER CATEGORIES ENDPOINT
// ============================================

/**
 * GET /flexcube/customer-categories
 * Fetch distinct customer categories from Flexcube STTM_CUSTOMER table
 */
router.get("/flexcube/customer-categories", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT CUSTOMER_CATEGORY
            FROM sttm_customer
            WHERE CUSTOMER_CATEGORY IS NOT NULL
            ORDER BY CUSTOMER_CATEGORY
        `;

        const result = await executeQuery(query);

        if (!result.success) {
            // If Flexcube is not available, return sample data for testing
            console.warn("Flexcube query failed, returning sample data:", result.error);
            return res.status(200).json({
                error: false,
                message: "Customer categories fetched (sample data - Flexcube unavailable)",
                data: [
                    { CUSTOMER_CATEGORY: 'CORPORATE' },
                    { CUSTOMER_CATEGORY: 'INDIVIDUAL' },
                    { CUSTOMER_CATEGORY: 'GOVERNMENT' },
                    { CUSTOMER_CATEGORY: 'NGO' },
                    { CUSTOMER_CATEGORY: 'PREMIUM' },
                    { CUSTOMER_CATEGORY: 'RETAIL' },
                    { CUSTOMER_CATEGORY: 'SME' },
                    { CUSTOMER_CATEGORY: 'VIP' },
                ],
                is_sample: true,
            });
        }

        res.status(200).json({
            error: false,
            message: "Customer categories fetched successfully from Flexcube",
            data: result.data,
            is_sample: false,
        });
    } catch (error) {
        console.error("Error fetching customer categories:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to fetch customer categories",
        });
    }
});

// ============================================
// UTILITY ENDPOINT - Check if transaction needs checker
// ============================================

/**
 * POST /check-maker-checker
 * Check if a transaction amount requires maker-checker approval
 */
router.post("/check-maker-checker", auth, async (req, res) => {
    try {
        const { amount, currency } = req.body;

        if (amount === undefined || amount === null) {
            return res.status(400).json({
                error: true,
                message: "Amount is required",
            });
        }

        const threshold = await MakerCheckerThreshold.findOne({
            is_active: true,
            currency: currency || 'ETB'
        });

        if (!threshold) {
            // No threshold configured - assume all transactions need checker
            return res.status(200).json({
                error: false,
                message: "No threshold configured",
                data: {
                    needs_checker: true,
                    reason: "No maker-checker threshold configured - all transactions require checker approval",
                    threshold_amount: 0,
                },
            });
        }

        const transactionAmount = parseFloat(amount);
        const needsChecker = transactionAmount >= threshold.threshold_amount;

        res.status(200).json({
            error: false,
            message: needsChecker
                ? "Transaction requires checker approval"
                : "Transaction does not require checker approval",
            data: {
                needs_checker: needsChecker,
                transaction_amount: transactionAmount,
                threshold_amount: threshold.threshold_amount,
                currency: threshold.currency,
            },
        });
    } catch (error) {
        console.error("Error checking maker-checker:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to check maker-checker requirement",
        });
    }
});

/**
 * GET /customer-category-limit/:category
 * Get limit for a specific customer category
 */
router.get("/customer-category-limit/:category", auth, async (req, res) => {
    try {
        const limit = await CustomerCategoryLimit.findOne({
            customer_category: req.params.category,
            is_active: true
        });

        if (!limit) {
            return res.status(200).json({
                error: false,
                message: "No limit configured for this customer category",
                data: {
                    customer_category: req.params.category,
                    daily_limit: null,
                    is_configured: false,
                },
            });
        }

        res.status(200).json({
            error: false,
            message: "Customer category limit fetched successfully",
            data: {
                ...limit.toObject(),
                is_configured: true,
            },
        });
    } catch (error) {
        console.error("Error fetching customer category limit:", error);
        res.status(500).json({
            error: true,
            message: error.message || "Failed to fetch customer category limit",
        });
    }
});

export default router;
