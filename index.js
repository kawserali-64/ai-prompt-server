const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());

// MongoDB Setup
const uri = process.env.MONGODB_DB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

// MAIN RUN FUNCTION
async function run() {
    try {
        await client.connect();

        const db = client.db("ai_promt_client");

        const prompts = db.collection("prompts");
        const reviews = db.collection("reviews");
        const bookmarks = db.collection("bookmarks");
        const subscriptions = db.collection("subscriptions");
        const userCollection = db.collection("user")

        console.log("MongoDB Connected");

        // HEALTH CHECK
        app.get("/", (req, res) => {
            res.send("hello world!");
        });

        // GET ALL PROMPTS
        app.get("/api/prompts", async (req, res) => {
            try {
                const {
                    userId,
                    search,
                    category,
                    tool,
                    difficulty,
                    sort,
                    page = 1,
                    limit = 9,
                } = req.query;

                const query = {};

                // ✅ IMPORTANT: all prompts page এ userId কখনো use করবে না
                if (userId) {
                    query.userId = userId;
                } else {
                    query.status = "approved";
                    query.visibility = "Public";
                }

                // SEARCH
                if (search) {
                    query.$or = [
                        { title: { $regex: search, $options: "i" } },
                        { tool: { $regex: search, $options: "i" } },
                        {
                            tags: {
                                $elemMatch: {
                                    $regex: search,
                                    $options: "i",
                                },
                            },
                        },
                    ];
                }

                if (category && category !== "All") {
                    query.category = category;
                }

                if (tool && tool !== "All") {
                    query.tool = tool;
                }

                if (difficulty && difficulty !== "All") {
                    query.difficulty = difficulty;
                }

                // SORT
                let sortQuery = { createdAt: -1 };

                if (sort === "popular") sortQuery = { averageRating: -1 };
                if (sort === "copied") sortQuery = { copyCount: -1 };
                if (sort === "latest") sortQuery = { createdAt: -1 };

                // PAGINATION
                const pageNum = Number(page);
                const limitNum = Number(limit);
                const skip = (pageNum - 1) * limitNum;

                const total = await prompts.countDocuments(query);

                const result = await prompts
                    .find(query)
                    .sort(sortQuery)
                    .skip(skip)
                    .limit(limitNum)
                    .toArray();

                res.send({
                    prompts: result,
                    total,
                    currentPage: pageNum,
                    totalPages: Math.ceil(total / limitNum),
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // FEATURED PROMPTS 
        app.get("/api/prompts/featured", async (req, res) => {
            try {
                const result = await prompts
                    .find({
                        status: "approved",
                        visibility: "Public",
                    })
                    .sort({ copyCount: -1, createdAt: -1 }) // 👈 trending logic
                    .limit(6)
                    .toArray();

                res.send({
                    success: true,
                    prompts: result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // TOP CREATORS API
        app.get("/api/top-creators", async (req, res) => {
            try {
                const result = await prompts.aggregate([
                    {
                        $addFields: {
                            userObjId: { $toObjectId: "$userId" }
                        }
                    },

                    {
                        $group: {
                            _id: "$userObjId",
                            totalPrompts: { $sum: 1 },
                            totalCopies: { $sum: { $ifNull: ["$copyCount", 0] } },
                        }
                    },

                    {
                        $lookup: {
                            from: "user",
                            localField: "_id",
                            foreignField: "_id",
                            as: "user",
                        }
                    },

                    { $unwind: "$user" },

                    {
                        $match: {
                            "user.role": "Creator"
                        }
                    },

                    {
                        $project: {
                            _id: 1,
                            totalPrompts: 1,
                            totalCopies: 1,
                            name: "$user.name",
                            email: "$user.email",
                            role: "$user.role",
                            plan: "$user.plan",

                            // 🔥 FIXED PHOTO (SAFE)
                            photo: {
                                $ifNull: [
                                    "$user.photoURL",
                                    "$user.photo",
                                    "$user.image",
                                    null
                                ]
                            }
                        }
                    },

                    {
                        $sort: {
                            totalCopies: -1,
                            totalPrompts: -1,
                        }
                    },

                    { $limit: 6 }

                ]).toArray();

                res.send({
                    success: true,
                    creators: result,
                });

            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // Trending api 
        app.get("/api/prompts/trending", async (req, res) => {
            try {
                const sevenDaysAgo = new Date();
                sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

                const result = await prompts.find({
                    status: "approved",
                    visibility: "Public",
                    createdAt: { $gte: sevenDaysAgo },
                })
                    .sort({
                        // 🔥 CORE VIRAL SIGNALS
                        copyCount: -1,
                        averageRating: -1,

                        // 🔥 IMPORTANT: freshness boost
                        createdAt: -1,
                    })
                    .limit(6)
                    .toArray();

                res.send({
                    success: true,
                    prompts: result,
                });

            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // CREATOR ANALYTICS API
        app.get("/api/creator/analytics", async (req, res) => {
            try {
                let { userId } = req.query;

                if (!userId) {
                    return res.status(400).send({
                        success: false,
                        message: "userId required",
                    });
                }

                // ✅ SAFE STRING CONVERSION (CRITICAL FIX)
                userId = String(userId);

                // =========================
                // 1. TOTAL PROMPTS
                // =========================
                const totalPrompts = await prompts.countDocuments({ userId });

                // =========================
                // 2. TOTAL COPIES
                // =========================
                const copyAgg = await prompts.aggregate([
                    { $match: { userId } },
                    {
                        $group: {
                            _id: null,
                            totalCopies: { $sum: "$copyCount" }
                        }
                    }
                ]).toArray();

                // =========================
                // 3. TOTAL BOOKMARKS
                // =========================
                const bookmarkAgg = await bookmarks.aggregate([
                    {
                        $addFields: {
                            promptObjId: {
                                $convert: {
                                    input: "$promptId",
                                    to: "objectId",
                                    onError: null,
                                    onNull: null
                                }
                            }
                        }
                    },
                    {
                        $lookup: {
                            from: "prompts",
                            localField: "promptObjId",
                            foreignField: "_id",
                            as: "prompt"
                        }
                    },
                    { $unwind: "$prompt" },
                    { $match: { "prompt.userId": userId } },
                    { $count: "totalBookmarks" }
                ]).toArray();

                // =========================
                // 4. TOTAL REVIEWS
                // =========================
                const reviewAgg = await reviews.aggregate([
                    {
                        $addFields: {
                            promptObjId: {
                                $convert: {
                                    input: "$promptId",
                                    to: "objectId",
                                    onError: null,
                                    onNull: null
                                }
                            }
                        }
                    },
                    {
                        $lookup: {
                            from: "prompts",
                            localField: "promptObjId",
                            foreignField: "_id",
                            as: "prompt"
                        }
                    },
                    { $unwind: "$prompt" },
                    { $match: { "prompt.userId": userId } },
                    { $count: "totalReviews" }
                ]).toArray();

                // =========================
                // 5. PROMPT GROWTH
                // =========================
                const promptGrowth = await prompts.aggregate([
                    { $match: { userId } },
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    format: "%Y-%m-%d",
                                    date: "$createdAt"
                                }
                            },
                            count: { $sum: 1 }
                        }
                    },
                    { $sort: { _id: 1 } }
                ]).toArray();

                // =========================
                // 6. COPY TREND
                // =========================
                const copyTrend = await prompts.aggregate([
                    { $match: { userId } },
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    format: "%Y-%m-%d",
                                    date: "$createdAt"
                                }
                            },
                            totalCopies: { $sum: "$copyCount" }
                        }
                    },
                    { $sort: { _id: 1 } }
                ]).toArray();

                // =========================
                // FINAL RESPONSE
                // =========================
                res.send({
                    success: true,
                    data: {
                        totalPrompts,
                        totalCopies: copyAgg[0]?.totalCopies || 0,
                        totalBookmarks: bookmarkAgg[0]?.totalBookmarks || 0,
                        totalReviews: reviewAgg[0]?.totalReviews || 0,
                        promptGrowth,
                        copyTrend,
                    }
                });

            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // my prompt data 
        app.get("/api/my-prompts", async (req, res) => {
            try {
                const { userId } = req.query;

                const result = await prompts
                    .find({ userId })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send(error.message);
            }
        });

        // GET SINGLE PROMPT
        app.get("/api/prompts/:id", async (req, res) => {
            try {
                const id = req.params.id;

                const result = await prompts.findOne({
                    _id: new ObjectId(id),
                });

                res.send(result);
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // CREATE PROMPT
        app.post("/api/prompts", async (req, res) => {
            try {
                const prompt = req.body;

                // user info
                const userId = prompt.userId;
                const role = prompt.role;
                const isPremium = prompt.isPremium;

                // FREE USER LIMIT
                if (role === "User" && !isPremium) {
                    const totalPrompts = await prompts.countDocuments({
                        userId,
                    });

                    if (totalPrompts >= 3) {
                        return res.status(403).send({
                            success: false,
                            message:
                                "Free users can only create 3 prompts. Upgrade to Premium.",
                        });
                    }
                }

                // creator = unlimited
                // premium user = unlimited

                const newPrompt = {
                    ...prompt,
                    copyCount: 0,
                    averageRating: 0,
                    totalReviews: 0,
                    totalBookmarks: 0,
                    status: "pending",
                    featured: false,
                    reports: [],
                    reportCount: 0,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const result = await prompts.insertOne(newPrompt);

                res.send({
                    success: true,
                    insertedId: result.insertedId,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // 
        app.post("/api/subscription", async (req, res) => {
            try {

                const {
                    session_id: sessionId,
                    priceId,
                    userId,
                    userEmail,
                } = req.body;

                const existingPayment =
                    await subscriptions.findOne({
                        transactionId: sessionId,
                    });

                if (existingPayment) {
                    return res.json({
                        success: true,
                        message: "Payment already processed",
                    });
                }

                await subscriptions.insertOne({
                    transactionId: sessionId,
                    sessionId,
                    priceId,
                    userId,
                    userEmail,
                    amount: 5,
                    currency: "USD",
                    createdAt: new Date(),
                });

                await userCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    {
                        $set: {
                            plan: "pro",
                        },
                    }
                );

                res.json({
                    success: true,
                    message: "Payment Successful",
                });

            } catch (error) {
                res.status(500).json({
                    success: false,
                    message: error.message,
                });
            }
        });

        // api / user
        app.get("/api/user", async (req, res) => {
            try {
                const { userId } = req.query;

                if (!ObjectId.isValid(userId)) {
                    return res.status(400).json({ message: "Invalid userId" });
                }

                const user = await userCollection.findOne({
                    _id: new ObjectId(userId),
                });

                if (!user) {
                    return res.status(404).json({ message: "User not found" });
                }

                res.send(user);
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // admin all prompts api
        app.get("/api/admin/prompts", async (req, res) => {
            try {
                const result = await prompts
                    .find()
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // admin all payments
        app.get("/api/admin/payments", async (req, res) => {
            try {

                const result = await subscriptions
                    .find()
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(result);

            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // Admin analytics api 
        app.get("/api/admin/analytics", async (req, res) => {
            try {

                // OVERVIEW CARDS

                const totalUsers = await userCollection.countDocuments();

                const totalPrompts = await prompts.countDocuments();

                const totalReviews = await reviews.countDocuments();

                // Total Copies
                const copyAgg = await prompts.aggregate([
                    {
                        $group: {
                            _id: null,
                            totalCopies: {
                                $sum: {
                                    $ifNull: ["$copyCount", 0],
                                },
                            },
                        },
                    },
                ]).toArray();

                // Total Revenue
                const revenueAgg = await subscriptions.aggregate([
                    {
                        $group: {
                            _id: null,
                            totalRevenue: {
                                $sum: {
                                    $ifNull: ["$amount", 0],
                                },
                            },
                        },
                    },
                ]).toArray();

                // ENGINE STATS

                const engineStats = await prompts.aggregate([
                    {
                        $group: {
                            _id: {
                                $ifNull: ["$tool", "Unknown"],
                            },

                            promptCount: {
                                $sum: 1,
                            },

                            totalCopies: {
                                $sum: {
                                    $ifNull: ["$copyCount", 0],
                                },
                            },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            engine: "$_id",
                            promptCount: 1,
                            totalCopies: 1,
                        },
                    },
                    {
                        $sort: {
                            promptCount: -1,
                        },
                    },
                ]).toArray();

                // RESPONSE

                res.send({
                    success: true,

                    overview: {
                        totalUsers,
                        totalPrompts,
                        totalReviews,
                        totalCopies: copyAgg[0]?.totalCopies || 0,
                        totalRevenue: revenueAgg[0]?.totalRevenue || 0,
                    },

                    engineStats,
                });

            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // GET REPORTED PROMPTS (ADMIN)
        app.get("/api/admin/reported-prompts", async (req, res) => {
            try {
                const result = await prompts
                    .find({ reportCount: { $gt: 0 } })
                    .sort({ reportCount: -1 })
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // admin all user api
        app.get("/api/users", async (req, res) => {
            try {
                const result = await userCollection
                    .find()
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });


        // UPDATE PROMPT
        app.patch("/api/prompts/:id", async (req, res) => {
            try {
                const { id } = req.params;
                const updatedData = req.body;

                const allowedFields = [
                    "title",
                    "description",
                    "content",
                    "category",
                    "tool",
                    "tags",
                    "difficulty",
                    "visibility",
                ];

                const safeUpdate = {};

                allowedFields.forEach((key) => {
                    if (updatedData[key] !== undefined) {
                        safeUpdate[key] = updatedData[key];
                    }
                });

                const result = await prompts.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            ...safeUpdate,
                            updatedAt: new Date(),
                        },
                    }
                );

                res.send({
                    success: true,
                    message: "Prompt updated successfully",
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // all admin prompt approved api
        app.patch("/api/prompts/:id/approve", async (req, res) => {
            try {
                const { id } = req.params;

                const result = await prompts.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            status: "approved",
                            rejectionFeedback: "",
                            updatedAt: new Date()
                        },
                    }
                );

                res.send({
                    success: true,
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // all admin prompt rejected api
        app.patch("/api/prompts/:id/reject", async (req, res) => {
            try {
                const { id } = req.params;
                const { feedback } = req.body;

                const result = await prompts.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            status: "rejected",
                            rejectionFeedback: feedback,
                            updatedAt: new Date(),


                        },
                    }
                );

                res.send({
                    success: true,
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // all admin feature api
        app.patch("/api/prompts/:id/feature", async (req, res) => {
            try {
                const { id } = req.params;
                const { featured } = req.body;

                const result = await prompts.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            featured,
                            updatedAt: new Date(),
                        },
                    }
                );

                res.send({
                    success: true,
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // DELETE PROMPT
        app.delete("/api/prompts/:id", async (req, res) => {
            try {
                const { id } = req.params;

                const result = await prompts.deleteOne({
                    _id: new ObjectId(id),
                });

                // OPTIONAL: delete related reviews + bookmarks
                await reviews.deleteMany({ promptId: new ObjectId(id) });
                await bookmarks.deleteMany({ promptId: id });

                res.send({
                    success: true,
                    message: "Prompt deleted successfully",
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // admin user delete api
        app.delete("/api/users/:id", async (req, res) => {
            try {
                const { id } = req.params;

                const result = await userCollection.deleteOne({
                    _id: new ObjectId(id),
                });

                res.send({
                    success: true,
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });


        // COPY COUNT INCREMENT
        app.patch("/api/prompts/:id/copy", async (req, res) => {
            try {
                const { id } = req.params;

                const result = await prompts.findOneAndUpdate(
                    { _id: new ObjectId(id) },
                    { $inc: { copyCount: 1 } },
                    { returnDocument: "after" }
                );

                if (!result) {
                    return res.status(404).json({
                        success: false,
                        message: "Prompt not found",
                    });
                }

                res.json({
                    success: true,
                    copyCount: result.copyCount,
                });

            } catch (err) {
                res.status(500).json({
                    success: false,
                    message: err.message,
                });
            }
        });

        // admin patch api
        app.patch("/api/users/:id/role", async (req, res) => {
            try {
                const { id } = req.params;
                const { role } = req.body;

                const result = await userCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            role,
                        },
                    }
                );

                res.send({
                    success: true,
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // admin report clear
        app.patch("/api/prompts/:id/dismiss-reports", async (req, res) => {
            try {
                const { id } = req.params;

                const result = await prompts.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            reports: [],
                            reportCount: 0,
                            updatedAt: new Date(),
                        },
                    }
                );

                res.send({
                    success: true,
                    message: "Reports dismissed",
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });


        // REVIEWS GET
        app.get("/api/review", async (req, res) => {
            try {
                const { promptId, userId } = req.query;

                const match = {};

                if (promptId) {
                    match.promptId = new ObjectId(promptId);
                }

                if (userId) {
                    match.userId = userId;
                }

                const result = await reviews
                    .aggregate([
                        {
                            $match: match,
                        },
                        {
                            $lookup: {
                                from: "prompts",
                                localField: "promptId",
                                foreignField: "_id",
                                as: "prompt",
                            },
                        },
                        {
                            $unwind: "$prompt",
                        },
                        {
                            $project: {
                                _id: 1,
                                rating: 1,
                                comment: 1,
                                createdAt: 1,
                                promptId: 1,

                                promptTitle: "$prompt.title",
                                aiTool: "$prompt.tool",
                            },
                        },
                        {
                            $sort: {
                                createdAt: -1,
                            },
                        },
                    ])
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: "Failed to fetch reviews",
                });
            }
        });

        // reviews customer api 
        app.get("/api/customer-reviews", async (req, res) => {
            try {

                const result = await reviews.aggregate([

                    {
                        $sort: {
                            rating: -1,
                            createdAt: -1,
                        },
                    },

                    {
                        $limit: 6,
                    },

                    {
                        $lookup: {
                            from: "prompts",
                            localField: "promptId",
                            foreignField: "_id",
                            as: "prompt",
                        },
                    },

                    {
                        $unwind: "$prompt",
                    },

                    {
                        $addFields: {
                            userObjId: {
                                $convert: {
                                    input: "$userId",
                                    to: "objectId",
                                    onError: null,
                                    onNull: null,
                                },
                            },
                        },
                    },

                    {
                        $lookup: {
                            from: "user",
                            localField: "userObjId",
                            foreignField: "_id",
                            as: "user",
                        },
                    },

                    {
                        $unwind: "$user",
                    },

                    {
                        $project: {
                            _id: 1,
                            rating: 1,
                            comment: 1,
                            createdAt: 1,
                            promptTitle: "$prompt.title",
                            aiTool: "$prompt.tool",
                            userName: "$user.name",
                            userEmail: "$user.email",
                            userPhoto: {
                                $ifNull: [
                                    "$user.photoURL",
                                    "$user.photo",
                                    "$user.image",
                                    null,
                                ],
                            },
                        },
                    },

                ]).toArray();

                res.send({
                    success: true,
                    reviews: result,
                });

            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // CREATE REVIEW + UPDATE PROMPT RATING
        app.post("/api/review", async (req, res) => {
            try {
                const { promptId, rating, comment, userId } = req.body;

                if (!promptId) {
                    return res.status(400).json({ message: "promptId required" });
                }

                const objectId = new ObjectId(promptId);

                await reviews.insertOne({
                    promptId: objectId,
                    rating: Number(rating),
                    comment,
                    userId,
                    createdAt: new Date(),
                });

                const allReviews = await reviews
                    .find({ promptId: objectId })
                    .toArray();

                const totalReviews = allReviews.length;

                const averageRating =
                    totalReviews === 0
                        ? 0
                        : allReviews.reduce((acc, r) => acc + Number(r.rating), 0) /
                        totalReviews;

                await prompts.updateOne(
                    { _id: objectId },
                    {
                        $set: {
                            averageRating,
                            totalReviews,
                        },
                    }
                );

                res.json({
                    success: true,
                    averageRating,
                    totalReviews,
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    message: error.message,
                });
            }
        });

        // report admin warn -user
        app.post("/api/admin/warn-user", async (req, res) => {
            try {
                const { userId, message } = req.body;

                // simple warning system (user collection update)
                const result = await userCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    {
                        $push: {
                            warnings: {
                                message,
                                createdAt: new Date(),
                            },
                        },
                    }
                );

                res.send({
                    success: true,
                    message: "User warned successfully",
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // BOOKMARK TOGGLE
        app.post("/api/bookmarks", async (req, res) => {
            try {
                const { userId, promptId } = req.body;

                const existing = await bookmarks.findOne({ userId, promptId });

                if (existing) {
                    await bookmarks.deleteOne({
                        userId,
                        promptId,
                    });

                    await prompts.updateOne(
                        { _id: new ObjectId(promptId) },
                        { $inc: { totalBookmarks: -1 } }
                    );

                    return res.send({ success: true, saved: false });
                }

                await bookmarks.insertOne({
                    userId,
                    promptId,
                    createdAt: new Date(),
                });

                await prompts.updateOne(
                    { _id: new ObjectId(promptId) },
                    { $inc: { totalBookmarks: 1 } }
                );

                res.send({ success: true, saved: true });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // REPORT PROMPT API
        app.post("/api/prompts/:id/report", async (req, res) => {
            try {
                const { id } = req.params;
                const { userId, reason, message } = req.body;

                if (!userId || !reason) {
                    return res.status(400).send({
                        success: false,
                        message: "userId and reason are required",
                    });
                }

                const reportData = {
                    userId,
                    reason,
                    message: message || "",
                    createdAt: new Date(),
                };

                const result = await prompts.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $push: { reports: reportData },
                        $inc: { reportCount: 1 },
                        $set: { updatedAt: new Date() },
                    }
                );

                res.send({
                    success: true,
                    message: "Report submitted successfully",
                    result,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // GET BOOKMARKS WITH POPULATED PROMPTS
        app.get("/api/bookmarks", async (req, res) => {
            try {
                const { userId } = req.query;

                const result = await bookmarks
                    .aggregate([
                        { $match: { userId } },
                        {
                            $addFields: {
                                promptObjId: {
                                    $toObjectId: "$promptId",
                                },
                            },
                        },
                        {
                            $lookup: {
                                from: "prompts",
                                localField: "promptObjId",
                                foreignField: "_id",
                                as: "prompt",
                            },
                        },
                        { $unwind: "$prompt" },
                    ])
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // MONGO PING
        await client.db("admin").command({ ping: 1 });
        console.log("MongoDB Ping Successful");
    } finally {
        // keep connection open
    }
}

run().catch(console.dir);

// SERVER START
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});