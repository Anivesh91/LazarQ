import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "playground ready" });
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Playground producer running on port ${PORT}`);
});
