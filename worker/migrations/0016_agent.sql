-- Which agent a worker runs, as it reports it at claim time: "<provider>/<model>"
-- (anthropic/claude-sonnet-5, openai/gpt-5, …) or NULL when the worker has no
-- agent key. Informational — the key itself never leaves the worker.
ALTER TABLE build_workers ADD COLUMN agent TEXT;
