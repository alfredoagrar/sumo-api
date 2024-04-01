import { OpenAIService } from "../../openai/services/openai.service";
import { PromptService } from "../../prompts/services/prompt.services";

/**
 * Service class for summarizing text using OpenAI.
 */
export class SummaryService {
    private openai: OpenAIService = new OpenAIService();
    private prompts: PromptService = new PromptService();

    /**
     * Summarizes the given text using OpenAI.
     * @param text - The text to be summarized.
     * @returns A promise that resolves to the summarized text.
     */
    async summarizeTextBasic(text: string): Promise<string> {
        let summary = await this.openai.executePrompt(this.prompts.getBasicSummarizationPrompt(text));
        return summary as string;
    }

    /**
     * Generates a basic conclusion text based on the given input text.
     * @param text - The input text to generate the conclusion from.
     * @returns A Promise that resolves to the generated conclusion text.
     */
    async conclusionTextBasic(text: string): Promise<string> {
        let summary = await this.openai.executePrompt(this.prompts.getConclusionPrompt(text));
        return summary as string;
    }
}