import { BadGatewayException } from '@nestjs/common';

/**
 * Thrown when a WeCom webhook push fails for an outbound reason: network /
 * timeout / non-2xx HTTP / non-JSON body / errcode != 0. Maps to 502 so the
 * config UI can distinguish "your message was handed to WeCom successfully"
 * (200) from "WeCom rejected or could not be reached" (502). The failure
 * reason is a WeCom-level code/message, surfaced in `details` - the response
 * deliberately never echoes the webhook URL or key.
 */
export class NotificationSendException extends BadGatewayException {
  constructor(wecomErrCode: number, wecomErrMsg: string) {
    super({
      code: 'NOTIFICATION_SEND_FAILED',
      message: 'Failed to deliver notification to WeCom webhook.',
      details: { wecomErrCode, wecomErrMsg },
    });
  }
}
