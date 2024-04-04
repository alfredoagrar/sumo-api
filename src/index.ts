import express from 'express';
import dotenv from 'dotenv';
import summaryRouter from './summary/summaryRouter';

dotenv.config();

const app = express();
/**
 * The port number for the server.
 * @type {number | string}
 */
const PORT: number | string = process.env.PORT || 3000;

app.use(express.json()); // Middleware pto parse JSON


app.use('/sumo', summaryRouter);


app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});