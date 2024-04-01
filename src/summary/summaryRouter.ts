import { Router } from 'express';
import * as summaryController from './controllers/summaryController';

/**
 * Router for handling summary routes.
 *
 * @remarks
 * This router is responsible for handling all the summary-related routes.
 * It provides endpoints for retrieving, creating, updating, and deleting summaries.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { router } from './summaryRouter';
 *
 * const app = express();
 * app.use('/summary', router);
 * ```
 */
/**
 * Express router for handling summary routes.
 */
const router = Router();

router.post('/basic', summaryController.summarizationTextBasic);

export default router;