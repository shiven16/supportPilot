import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import { RunnableSequence } from '@langchain/core/runnables';
import { z } from 'zod';

function zodToTemplate(schema: any): any {
  if (schema instanceof z.ZodObject) {
    const obj: any = {};
    for (const [key, value] of Object.entries(schema.shape)) {
      obj[key] = zodToTemplate(value);
    }
    return obj;
  } else if (schema instanceof z.ZodArray) {
    return [zodToTemplate(schema.element)];
  } else if (schema instanceof z.ZodEnum) {
    return `one of: [${schema.options.join(', ')}]`;
  } else if (schema instanceof z.ZodString) {
    return 'string';
  } else if (schema instanceof z.ZodNumber) {
    return 'number';
  } else if (schema instanceof z.ZodBoolean) {
    return 'boolean';
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return zodToTemplate(schema.unwrap()) + ' (optional)';
  }
  return 'any';
}

export async function invokeWithStructuredOutput<T>(
  llm: BaseChatModel,
  prompt: any,
  schema: z.ZodType<T>,
  input: any
): Promise<T> {
  // 1. Try native structured output first
  try {
    const chain = RunnableSequence.from([
      prompt,
      llm.withStructuredOutput(schema)
    ]);
    return (await chain.invoke(input)) as T;
  } catch (error) {
    // 2. Fall back to manual JSON parsing if native structured output fails
    const jsonTemplate = zodToTemplate(schema);
    const jsonInstruction = `\nIMPORTANT: You must return ONLY a valid JSON object matching this schema template:
${JSON.stringify(jsonTemplate, null, 2)}
Do not wrap your output in markdown blocks, code blocks, or include any preamble/explanation. Just output the raw JSON.`;

    const messages = await prompt.formatMessages(input);
    messages.push(new SystemMessage(jsonInstruction));

    const response = await llm.invoke(messages);
    const text = response.content.toString().trim();

    try {
      // Clean markdown code blocks if the LLM ignored the instructions and wrapped it
      const cleanText = text
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
      return JSON.parse(cleanText) as T;
    } catch (parseError) {
      throw new Error(
        `Failed to parse manual JSON output from LLM: ${text}. Original error: ${parseError.message}`
      );
    }
  }
}
