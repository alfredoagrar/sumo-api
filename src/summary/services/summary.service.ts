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
}