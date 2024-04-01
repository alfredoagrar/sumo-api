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

    /**
     * Returns a prompt for generating bullet points based on the given text.
     * @param text - The input text.
     * @returns The bullet points prompt.
     */
    getBulletPointsPrompt(text: string): string {
        return `Create a list of 10 bullet points based in the text found between triple quotes. 
        text : '''${text}'''`;
    }

    /**
     * Retrieves an inferring prompt based on the provided text.
     * 
     * @param {string} text - The text to be included in the prompt.
     * @returns {string} - The inferring prompt.
     */
    getInferringPrompt(text: string): string {
        return `Identify a list of emotions that the writer of the 
        following review in the text found between triple quotes. 
        Include no more than 
        five items in the list. Format your answer as a list of 
        lower-case words separated by commas.

        text : '''${text}'''`;
    }
}