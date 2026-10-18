import OpenAI from 'openai';

export function createClient(profile) {
  // Local servers (Ollama etc.) need no key, but the SDK requires a non-empty string.
  const apiKey = profile.keyEnv ? process.env[profile.keyEnv] : 'none';
  return new OpenAI({ baseURL: profile.baseURL, apiKey });
}

export async function call({ client, profile, model, system, messages, tools, timeoutMs, signal }) {
  const response = await client.chat.completions.create({
    model,
    max_tokens: profile.maxOutputTokens,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: tools.length
      ? tools.map((tool) => ({ type: 'function', function: tool }))
      : undefined,
  }, { timeout: timeoutMs, signal });

  const message = response.choices[0].message;
  const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: message.content ?? '',
    assistantMessage: message,
    toolCalls: (message.tool_calls ?? [])
      .filter((toolCall) => toolCall.type === 'function')
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        args: JSON.parse(toolCall.function.arguments || '{}'),
      })),
    usage: {
      inputTokens: (response.usage?.prompt_tokens ?? 0) - cached,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cachedTokens: cached,
    },
  };
}

export function toolResults(toolCalls, results) {
  return toolCalls.map((toolCall, i) => ({ role: 'tool', tool_call_id: toolCall.id, content: results[i] }));
}
