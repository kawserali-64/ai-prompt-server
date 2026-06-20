const express = require('express');
const cors = require('cors');
const app = express();
const port = 5000;
require('dotenv').config()

app.use(cors());
app.use(express.json())

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

app.get('/', (req, res) => {
    res.send('Hello World!');
});



const uri = process.env.MONGODB_DB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();



        const database = client.db("ai_promt_client")
        const prompts = database.collection("prompts");
        const reviews = database.collection("reviews");


        app.get("/api/prompts", async (req, res) => {

            const query = {};

            if (req.query.userId) {

                query.userId = req.query.userId;

            }

            const result = await prompts

                .find(query)

                .sort({ createdAt: -1 })

                .toArray();

            res.send(result);

        });

        // /api/prompts
        app.get("/api/prompts", async (req, res) => {
            const query = {};

            if (req.query.userId) {
                query.userId = req.query.userId;
            }

            const result = await prompts
                .find(query)
                .sort({ createdAt: -1 })
                .toArray();

            res.send(result);
        });

        app.get('/api/prompts/:id', async (req, res) => {
            const id = req.params.id;
            const query = {
                _id: new ObjectId(id)
            }
            const result = await prompts.findOne(query);
            res.send(result)
        })
        // get reviews api
        app.get("/api/review", async (req, res) => {
            try {
                const { promptId, userId } = req.query;

                const query = {};

                if (promptId) {
                    query.promptId = new ObjectId(promptId); // ✅ FIXED
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
                console.log(error);
                res.status(500).send({
                    success: false,
                    message: "Failed to fetch reviews",
                });
            }
        });


        // create review
        app.post("/api/review", async (req, res) => {
            try {
                const { promptId, rating, comment, userId } = req.body;

                if (!promptId) {
                    return res.status(400).json({ message: "promptId required" });
                }

                const objectId = new ObjectId(promptId);

                // 1. insert review
                await reviews.insertOne({
                    promptId: objectId,
                    rating: Number(rating),
                    comment,
                    userId,
                    createdAt: new Date(),
                });

                // 2. fetch all reviews
                const allReviews = await reviews
                    .find({ promptId: objectId })
                    .toArray();

                const totalReviews = allReviews.length;

                const averageRating =
                    totalReviews === 0
                        ? 0
                        : allReviews.reduce((acc, r) => acc + Number(r.rating), 0) /
                        totalReviews;

                // 3. UPDATE PROMPT (IMPORTANT DEBUG LOG ADDED)
                const updateResult = await prompts.updateOne(
                    { _id: objectId },
                    {
                        $set: {
                            averageRating,
                            totalReviews,
                        },
                    }
                );

                console.log("UPDATE RESULT:", updateResult);

                res.json({
                    success: true,
                    averageRating,
                    totalReviews,
                    matched: updateResult.matchedCount,
                    modified: updateResult.modifiedCount,
                });
            } catch (error) {
                console.log(error);
                res.status(500).json({
                    success: false,
                    message: error.message,
                });
            }
        });

        app.post("/api/prompts", async (req, res) => {
            const prompt = req.body;

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
            res.send(result);
        });

        // patch api
        app.patch('/api/prompts/:id/copy', async (req, res) => {
            try {
                const { id } = req.params

                const result = await prompts.findOneAndUpdate(
                    { _id: new ObjectId(id) },
                    { $inc: { copyCount: 1 } },
                    { returnDocument: 'after', projection: { copyCount: 1 } }
                )

                if (!result) {
                    return res.status(404).json({ error: 'Prompt not found' })
                }

                res.json({ copyCount: result.copyCount })
            } catch (err) {
                console.log(err)
                res.status(500).json({ error: err.message })
            }
        })


        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);




app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});