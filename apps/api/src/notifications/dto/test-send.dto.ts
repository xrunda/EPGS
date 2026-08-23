import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { TestSendBody } from '@epgs/shared-types';

/** POST /api/notification-channels/{id}/test-send body. */
export class TestSendDto implements TestSendBody {
  @ApiProperty({
    example: 'd290f1ee-6c54-4b01-90e6-d701748f0851',
    description: 'Id of the notification_template to render and push.',
  })
  @IsUUID('all', { message: 'templateId must be a valid UUID' })
  templateId!: string;
}
