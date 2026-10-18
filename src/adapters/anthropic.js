import Anthropic from '@anthropic-ai/sdk';

export function createClient(profile) {
  return new Anthropic({ apiKey: profile.keyEnv ? process.env[profile.keyEnv] : undefined });
}

export async function call({ client, profile, model, system, messages, tools, timeoutMs }) {
  const response = await client.messages.create({
    model,
    max_tokens: profile.maxOutputTokens,
    system,
    messages,
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
  }, { timeout: timeoutMs });

  const usage = response.usage;
  return {
    text: response.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    assistantMessage: { role: 'assistant', content: response.content },
    toolCalls: response.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, args: block.input })),
    usage: {
      inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cachedTokens: usage.cache_read_input_tokens ?? 0,
    },
  };
}

export function toolResults(toolCalls, results) {
  return [{
    role: 'user',
    content: toolCalls.map((toolCall, i) => ({ type: 'tool_result', tool_use_id: toolCall.id, content: results[i] })),
  }];
}
