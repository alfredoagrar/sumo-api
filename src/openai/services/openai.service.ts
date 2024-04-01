import { OpenAI, ClientOptions } from 'openai';
import { ChatCompletion } from 'openai/resources';
import { config } from 'dotenv';

/**
 * Service class for interacting with the OpenAI API.
 */
export class OpenAIService {
    private api: OpenAI;

    constructor() {
        config();
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY environment variable is not defined.');
        }
        this.api = new OpenAI({ apiKey } as ClientOptions);
    }

    /**
     * Generates text based on the given prompt using the specified model.
     * @param prompt The prompt for generating text.
     * @param model The model to use for text generation. Defaults to 'gpt-3.5-turbo'.
     * @returns A promise that resolves to the generated text.
     */
    async executePrompt(prompt: string, model: string = 'gpt-3.5-turbo'): Promise<string| null> {
        const params: OpenAI.Chat.ChatCompletionCreateParams = {
            messages: [{ role: 'user', content: prompt }],
            model: model,
          };
        const response : ChatCompletion = await this.api.chat.completions.create(params);
        return response.choices[0].message.content;
    }
}