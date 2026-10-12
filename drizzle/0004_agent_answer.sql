CREATE TABLE "agent_answer" (
	"practice_id" uuid NOT NULL,
	"input_sha256" text NOT NULL,
	"job" text NOT NULL,
	"model_id" text NOT NULL,
	"served_model" text NOT NULL,
	"answer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_answer_pkey" PRIMARY KEY("practice_id","input_sha256"),
	CONSTRAINT "agent_answer_input_sha256" CHECK ("agent_answer"."input_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_answer_job" CHECK ("agent_answer"."job" in ('draft', 'update'))
);
--> statement-breakpoint
ALTER TABLE "agent_answer" ADD CONSTRAINT "agent_answer_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE cascade ON UPDATE no action;