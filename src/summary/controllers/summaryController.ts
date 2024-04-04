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

/**
 * Handles the request to generate a basic conclusion text.
 * @param req - The request object.
 * @param res - The response object.
 * @returns A Promise that resolves to void.
 */
export const conclusionTextBasic = async (req: Request, res: Response): Promise<void> => {
    const text: any = req.body.text;
    const summary = await service.conclusionTextBasic(text);
    res.send(summary);
}

/**
 * Handles the bullet points text basic operation.
 * 
 * @param req - The request object.
 * @param res - The response object.
 * @returns A Promise that resolves to void.
 */
export const bulletPointsTextBasic = async (req: Request, res: Response): Promise<void> => {
    const text: any = req.body.text;
    const summary = await service.BulletPointsTextBasic(text);
    res.send(summary);
}

/**
 * Handles the inferring text basic operation.
 * 
 * @param req - The request object.
 * @param res - The response object.
 * @returns A Promise that resolves to void.
 */
export const inferringTextBasic = async (req: Request, res: Response): Promise<void> => {
    const text: any = req.body.text;
    const summary = await service.inferringTextBasic(text);
    res.send(summary);
}