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

        console.log("MongoDB Connected");

        // HEALTH CHECK
        app.get("/", (req, res) => {
            res.send("hello world!");
        });

        // GET ALL PROMPTS
        app.get("/api/prompts", async (req, res) => {
            try {
                const query = {};

                if (req.query.userId) {
                    query.userId = req.query.userId;
                }

                const result = await prompts
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
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

        // COPY COUNT INCREMENT
        app.patch("/api/prompts/:id/copy", async (req, res) => {
            try {
                const { id } = req.params;

                const result = await prompts.findOneAndUpdate(
                    { _id: new ObjectId(id) },
                    { $inc: { copyCount: 1 } },
                    { returnDocument: "after" }
                );

                if (!result.value) {
                    return res.status(404).json({ error: "Prompt not found" });
                }

                res.json({
                    success: true,
                    copyCount: result.value.copyCount,
                });
            } catch (err) {
                res.status(500).json({ success: false, message: err.message });
            }
        });

        // REVIEWS GET
        app.get("/api/review", async (req, res) => {
            try {
                const { promptId, userId } = req.query;

                const query = {};

                if (promptId) {
                    query.promptId = new ObjectId(promptId);
                }

                if (userId) {
                    query.userId = userId;
                }

                const result = await reviews
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: "Failed to fetch reviews",
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