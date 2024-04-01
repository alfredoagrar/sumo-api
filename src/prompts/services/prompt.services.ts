export class PromptService {
    /**
     * Generates a prompt for summarizing the given text.
     * @param text - The text to be summarized.
     * @returns The generated prompt.
     */
    getBasicSummarizationPrompt(text: string): string {
        return `Create a summary from following text found between triple quotes. 
        use only 3 paragraphs.
        text : '''${text}'''`;
    }

    /**
     * Returns a conclusion prompt based on the provided text.
     * @param text - The input text.
     * @returns The conclusion prompt.
     */
    getConclusionPrompt(text: string): string {
        return `Create a conclusion for the text found between triple quotes. 
        respect the used lenguaje of the text.
        text : '''${text}'''`;
    }
}