-- Persist Pub/Sub messages the worker ack-drops (invalid JSON, unknown topic).
ALTER TYPE "WebhookFailureHandler" ADD VALUE 'ack_drop';
