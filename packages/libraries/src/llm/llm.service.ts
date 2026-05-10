import { AIMessage, BaseMessage } from '@langchain/core/messages';
import { Injectable } from '@nestjs/common';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { StructuredToolInterface } from "@langchain/core/tools";

@Injectable()
export class LlmService {
    private llm: ChatGoogleGenerativeAI;

    constructor() {
        this.llm = new ChatGoogleGenerativeAI({
            model: process.env.MODEL!,
            apiKey: process.env.GOOGLE_API_KEY,
        });
    }
    async invoke(messages: BaseMessage[]): Promise<string> {
        const response = await this.llm.invoke(messages);
        const contentArray = response.content as any[];
        return contentArray[contentArray.length - 1]?.text || "";
    }

    async invokeWithTools(messages: BaseMessage[], tools: StructuredToolInterface[]): Promise<AIMessage> {
        const llmWithTools = this.llm.bindTools(tools);
        return await llmWithTools.invoke(messages) as AIMessage;
    }
}