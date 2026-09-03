import { Module } from '@nestjs/common';
import { AssistantHeartbeatService } from './assistant-heartbeat.service';
import { AssistantEventsService } from './assistant-events.service';

/**
 * Push assistant worker half (issue #70): the DB heartbeat loop + the
 * activity-event recorder. PrismaModule is @Global so nothing extra needs
 * importing here.
 *
 * AssistantEventsService is exported so SyncModule (SYNC_DONE / KEYWORD_HIT
 * after a sync pass) and NotificationPushModule (PUSH_DONE after a rule run)
 * can append feed events without either of them depending on the heartbeat.
 */
@Module({
  providers: [AssistantHeartbeatService, AssistantEventsService],
  exports: [AssistantEventsService],
})
export class AssistantModule {}
