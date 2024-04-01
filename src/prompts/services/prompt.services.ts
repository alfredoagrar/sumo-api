export class PromptService {
    /**
     * Generates a prompt for summarizing the given text.
     * @param text - The text to be summarized.
     * @returns The generated prompt.
     */
    getBasicSummarizationPrompt(text: string): string {
        return `Summarize the following text: ${text}`;
    }
}