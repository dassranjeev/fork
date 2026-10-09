import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { AssistantConfigService } from './assistant-config.service';
import { AssistantKnowledgeService } from './assistant-knowledge.service';
import { AdminAssistantController, AssistantIconController, AssistantWidgetController, CustomerAssistantController, PublicAssistantController, RestaurantAssistantController } from './assistant.controllers';
import { AssistantService } from './assistant.service';
import { AssistantAdminController, AssistantAdminService } from './assistant-admin.controller';
import { AssistantBrains } from './brain/brain.registry';
import { LlmBrain } from './brain/llm.brain';
import { ALIAS_RESOLVER, KNOWLEDGE_PROVIDER } from './brain/hooks';
import { AdminCentralTrainingController, AdminRestaurantTrainingController, AdminTrainingController, RestaurantTrainingController } from './training/training.controllers';
import { TrainedKnowledge } from './training/training.runtime';
import { TrainingService } from './training/training.service';
import { TrainingStore } from './training/training.store';

/**
 * The ordering assistant ("bot"): a private assistant per restaurant (embeddable on the merchant's own website) plus one central
 * FORKSY bot. See docs/assistant.md. Deterministic engine, no external AI service required.
 */
@Module({
  imports: [CustomersModule],
  providers: [AssistantConfigService, AssistantKnowledgeService, AssistantService, AssistantAdminService, AssistantBrains, LlmBrain, TrainingStore, TrainingService, TrainedKnowledge, { provide: KNOWLEDGE_PROVIDER, useExisting: TrainedKnowledge }, { provide: ALIAS_RESOLVER, useExisting: TrainedKnowledge }],
  controllers: [PublicAssistantController, AssistantWidgetController, AssistantIconController, CustomerAssistantController, RestaurantAssistantController, AdminAssistantController, AssistantAdminController, RestaurantTrainingController, AdminRestaurantTrainingController, AdminCentralTrainingController, AdminTrainingController],
  exports: [AssistantConfigService, TrainingService, TrainingStore],
})
export class AssistantModule {}
