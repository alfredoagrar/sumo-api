import { SummaryService } from "../services/summary.service";
import { Request, Response } from 'express';


const service : SummaryService = new SummaryService();

/**
 * Handles the request to summarize a text using basic summarization.
 * 
 * @param req - The request object.
 * @param res - The response object.
 * @returns A Promise that resolves to void.
 */
export const summarizationTextBasic = async (req: Request, res: Response): Promise<void> => {
    const text: any = req.body.text;
    const summary = await service.summarizeTextBasic(text);
    res.send(summary);
}
