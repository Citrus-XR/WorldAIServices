import { AutoRouter } from 'itty-router';
import { Env } from './types';
import { jsonResponse, countCharacters, buildCacheKey, buildFixedCacheKey, buildFixedLangKey, JSON_HEADERS } from './utils';
import { TRANSLATION_FIXED_PROMPT_VERSION, TRANSLATION_PROMPT_VERSION } from './constants';
import { loadConfig, getCachedTranslation, runDatabaseMaintenance, recordError, checkRateLimit, recordTranslationStats } from './database';
import { executeFixedTranslation, executeTranslation, recordTranslationOutcome } from './translation';
import { handleManagerApi } from './manager';
import { buildManagerAppPageHtml, buildManagerLoginPageHtml } from './managerPage';

export { TranslationCoordinator } from './coordinator';

const router = AutoRouter();

router.options('*', () => new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-signature-ed25519,x-signature-timestamp,x-unity-version', 'access-control-allow-methods': 'GET,POST,OPTIONS' } }));

router.get('/', (request, env) => handleHealth(env));
router.get('/health', (request, env) => handleHealth(env));

router.get('/trans', (request, env, ctx) => handleTranslate(request, env, ctx, new URL(request.url)));

router.get('/mgr', () => handleManagerPage());
router.get('/mgr/', () => handleManagerPage());
router.get('/mgr/app', () => handleManagerAppPage());
router.get('/mgr/app/', () => handleManagerAppPage());
router.all('/mgr/api/*', (request, env, ctx) => handleManagerApi(request, env, ctx, new URL(request.url)));

export default {
	/**
	 * Main entry point for HTTP requests.
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			console.log(`[Worker] ${request.method} ${request.url}`);
			return await router.fetch(request, env, ctx);
		} catch (error) {
			const entry = {
				level: 'critical',
				code: 'UNHANDLED_EXCEPTION',
				message: '未処理例外が発生しました。',
				details: {
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack ?? '' : '',
					method: request.method,
					path: new URL(request.url).pathname,
				},
				occurredAt: new Date().toISOString(),
			};

			console.error(`[Worker] Critical error: ${entry.message}`, error);
			ctx.waitUntil(recordError(env, entry));
			return jsonResponse({ status: 'error', result: 'Server error' }, 500);
		}
	},

	/**
	 * Background tasks (Cron Triggers).
	 */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[Worker] Scheduled task started: ${controller.cron}`);
		ctx.waitUntil(runDatabaseMaintenance(env));
	},
} satisfies ExportedHandler<Env>;

async function handleHealth(env: Env) {
	const config = await loadConfig(env);
	return jsonResponse({
		status: 'ok',
		result: {
			enabled: config.enabled,
			requestsPerMinute: config.requestsPerMinute,
			maxChars: config.maxChars,
		},
	});
}

async function handleTranslate(request: Request, env: Env, ctx: ExecutionContext, url: URL) {
	if (!isAllowedUnityTranslateRequest(request)) return jsonResponse({ status: 'error', result: 'Unauthorized client' }, 403);

	const config = await loadConfig(env);
	if (!config.enabled) return jsonResponse({ status: 'error', result: 'Server is closed' }, 503);

	const parsed = parseTranslateQuery(url);
	if (!parsed) return jsonResponse({ status: 'error', result: 'Invalid request' }, 400);

	if (parsed.mode === 'fixed') return handleFixedTranslate(request, env, ctx, config, parsed);
	return handleLegacyTranslate(request, env, ctx, config, parsed);
}

async function handleLegacyTranslate(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	parsed: { mode: 'legacy'; lang: string; text: string }
) {
	const text = parsed.text.trim();
	if (text.length === 0) return buildCacheableTranslateResponse({ status: 'ok', result: '' });

	if (countCharacters(text) > config.maxChars) return jsonResponse({ status: 'error', result: 'Text too long' }, 400);

	const cacheKey = await buildCacheKey(parsed.lang, text, TRANSLATION_PROMPT_VERSION);
	const cached = await getCachedTranslation(env, cacheKey);
	if (cached !== null) {
		ctx.waitUntil(
			recordTranslationStats(env, {
				lang: parsed.lang,
				textLength: countCharacters(text),
				cacheHit: true,
				cacheMiss: false,
				aiRequest: false,
				aiSuccess: false,
				aiFailure: false,
			})
		);
		return buildCacheableTranslateResponse({ status: 'ok', result: cached });
	}

	const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
	const rateLimit = await checkRateLimit(env, clientIp, config.requestsPerMinute);
	if (!rateLimit.allowed) return jsonResponse({ status: 'error', result: 'Rate limit exceeded' }, 429);

	const translation = await executeTranslation(env, ctx, config, parsed.lang, text, {
		requestSource: 'translate-api',
		useCache: true,
		writeCache: true,
		useSingleFlight: true,
		recordStats: false, // will be recorded after outcome
	});

	if (!translation.ok) {
		ctx.waitUntil(recordTranslationOutcome(env, parsed.lang, countCharacters(text), translation));
		return jsonResponse({ status: 'error', result: translation.publicReason }, translation.statusCode);
	}

	ctx.waitUntil(recordTranslationOutcome(env, parsed.lang, countCharacters(text), translation));
	return buildCacheableTranslateResponse({ status: 'ok', result: translation.result });
}

async function handleFixedTranslate(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	parsed: { mode: 'fixed'; fromLang: string; toLang: string; text: string }
) {
	const text = parsed.text.trim();
	const langLabel = buildFixedLangKey(parsed.fromLang, parsed.toLang);

	if (text.length === 0) return buildCacheableTranslateResponse({ status: 'ok', result: '' });

	if (countCharacters(text) > config.maxChars) return jsonResponse({ status: 'error', result: 'Text too long' }, 400);

	if (parsed.fromLang === parsed.toLang) return buildCacheableTranslateResponse({ status: 'ok', result: text });

	const cacheKey = await buildFixedCacheKey(parsed.fromLang, parsed.toLang, text, TRANSLATION_FIXED_PROMPT_VERSION);
	const cached = await getCachedTranslation(env, cacheKey);
	if (cached !== null) {
		ctx.waitUntil(
			recordTranslationStats(env, {
				lang: langLabel,
				textLength: countCharacters(text),
				cacheHit: true,
				cacheMiss: false,
				aiRequest: false,
				aiSuccess: false,
				aiFailure: false,
			})
		);
		return buildCacheableTranslateResponse({ status: 'ok', result: cached });
	}

	const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
	const rateLimit = await checkRateLimit(env, clientIp, config.requestsPerMinute);
	if (!rateLimit.allowed) return jsonResponse({ status: 'error', result: 'Rate limit exceeded' }, 429);

	const translation = await executeFixedTranslation(env, ctx, config, parsed.fromLang, parsed.toLang, text, {
		requestSource: 'translate-api-fixed',
		useCache: true,
		writeCache: true,
		useSingleFlight: true,
		recordStats: false,
	});

	if (!translation.ok) {
		ctx.waitUntil(recordTranslationOutcome(env, langLabel, countCharacters(text), translation));
		return jsonResponse({ status: 'error', result: translation.publicReason }, translation.statusCode);
	}

	ctx.waitUntil(recordTranslationOutcome(env, langLabel, countCharacters(text), translation));
	return buildCacheableTranslateResponse({ status: 'ok', result: translation.result });
}

type ParsedTranslateQuery =
	| { mode: 'legacy'; lang: string; text: string }
	| { mode: 'fixed'; fromLang: string; toLang: string; text: string };

function parseTranslateQuery(url: URL): ParsedTranslateQuery | null {
	const entries = Array.from(url.searchParams.entries());
	if (entries.length === 0) return null;
	const firstEntry = entries[0];
	const firstKey = firstEntry[0].trim();
	if (firstKey.length === 0) return null;

	// 固定言語フォーマット: /trans?f={fromLang}&t={toLang}&t={text}
	if (firstKey === 'f') {
		const fromLang = String(firstEntry[1] ?? '').trim();
		if (fromLang.length === 0) return null;
		const tValues = url.searchParams.getAll('t');
		if (tValues.length < 2) return null;
		const toLang = String(tValues[0] ?? '').trim();
		if (toLang.length === 0) return null;
		// 2番目以降の t を結合して本文として扱う。空でも空文字として通す
		const text = tValues.slice(1).join('');
		return { mode: 'fixed', fromLang, toLang, text };
	}

	// 旧フォーマット: /trans?{lang}={text}
	return { mode: 'legacy', lang: firstKey, text: firstEntry[1] };
}

function isAllowedUnityTranslateRequest(request: Request) {
	const userAgent = String(request.headers.get('user-agent') ?? '');
	const accept = String(request.headers.get('accept') ?? '').trim();
	const unityVersion = String(request.headers.get('x-unity-version') ?? '').trim();
	return userAgent.includes('UnityPlayer') && accept === '*/*' && unityVersion.length > 0;
}

function handleManagerPage() {
	return new Response(buildManagerLoginPageHtml(), {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=UTF-8',
			'cache-control': 'no-store',
		},
	});
}

function handleManagerAppPage() {
	return new Response(buildManagerAppPageHtml(), {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=UTF-8',
			'cache-control': 'no-store',
		},
	});
}

function buildCacheableTranslateResponse(data: unknown) {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: {
			...JSON_HEADERS,
			'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
		},
	});
}
