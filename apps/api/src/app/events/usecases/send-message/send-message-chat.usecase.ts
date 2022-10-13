import { Injectable } from '@nestjs/common';
import { SendMessageType } from './send-message-type.usecase';
import { ChatFactory } from '../../services/chat-service/chat.factory';
import { CreateLog } from '../../../logs/usecases/create-log/create-log.usecase';
import { SendMessageCommand } from './send-message.command';
import * as Sentry from '@sentry/node';
import {
  NotificationRepository,
  NotificationStepEntity,
  SubscriberEntity,
  SubscriberRepository,
  MessageRepository,
  MessageEntity,
  NotificationEntity,
  IntegrationEntity,
} from '@novu/dal';
import {
  ChannelTypeEnum,
  LogCodeEnum,
  LogStatusEnum,
  ChatProviderIdEnum,
  ExecutionDetailsSourceEnum,
  ExecutionDetailsStatusEnum,
  StepTypeEnum,
} from '@novu/shared';
import { CreateLogCommand } from '../../../logs/usecases/create-log/create-log.command';
import { CompileTemplate } from '../../../content-templates/usecases/compile-template/compile-template.usecase';
import { CompileTemplateCommand } from '../../../content-templates/usecases/compile-template/compile-template.command';
import {
  GetDecryptedIntegrationsCommand,
  GetDecryptedIntegrations,
} from '../../../integrations/usecases/get-decrypted-integrations';
import { CreateExecutionDetails } from '../../../execution-details/usecases/create-execution-details/create-execution-details.usecase';
import { CreateExecutionDetailsCommand } from '../../../execution-details/usecases/create-execution-details/create-execution-details.command';

@Injectable()
export class SendMessageChat extends SendMessageType {
  private chatFactory = new ChatFactory();

  constructor(
    private subscriberRepository: SubscriberRepository,
    private notificationRepository: NotificationRepository,
    protected messageRepository: MessageRepository,
    protected createLogUsecase: CreateLog,
    protected createExecutionDetails: CreateExecutionDetails,
    private compileTemplate: CompileTemplate,
    private getDecryptedIntegrationsUsecase: GetDecryptedIntegrations
  ) {
    super(messageRepository, createLogUsecase, createExecutionDetails);
  }

  public async execute(command: SendMessageCommand) {
    Sentry.addBreadcrumb({
      message: 'Sending Chat',
    });
    const chatChannel: NotificationStepEntity = command.step;
    const notification = await this.notificationRepository.findById(command.notificationId);
    const subscriber: SubscriberEntity = await this.subscriberRepository.findOne({
      _environmentId: command.environmentId,
      _id: command.subscriberId,
    });
    let content = '';
    const data = {
      subscriber,
      step: {
        digest: !!command.events.length,
        events: command.events,
        total_count: command.events.length,
      },
      ...command.payload,
    };
    try {
      content = await this.compileTemplate.execute(
        CompileTemplateCommand.create({
          templateId: 'custom',
          customTemplate: chatChannel.template.content as string,
          data,
        })
      );
    } catch (e) {
      await this.createExecutionDetails.execute(
        CreateExecutionDetailsCommand.create({
          environmentId: command.environmentId,
          organizationId: command.organizationId,
          subscriberId: command.subscriberId,
          jobId: command.jobId,
          notificationId: notification._id,
          notificationTemplateId: notification._templateId,
          transactionId: command.transactionId,
          channel: StepTypeEnum.CHAT,
          detail: 'Message content could not be generated',
          source: ExecutionDetailsSourceEnum.INTERNAL,
          status: ExecutionDetailsStatusEnum.FAILED,
          isTest: false,
          isRetry: false,
          raw: JSON.stringify(data),
        })
      );

      return;
    }

    const chatChannels = subscriber.channels.filter((chan) =>
      Object.values(ChatProviderIdEnum).includes(chan.providerId as ChatProviderIdEnum)
    );

    for (const channel of chatChannels) {
      await this.sendChannelMessage(command, channel, notification, chatChannel, content);
    }
  }

  private async sendChannelMessage(
    command: SendMessageCommand,
    subscriberChannel,
    notification,
    chatChannel,
    content: string
  ) {
    const chatWebhookUrl = command.payload.webhookUrl || subscriberChannel.credentials.webhookUrl;

    const message: MessageEntity = await this.messageRepository.create({
      _notificationId: notification._id,
      _environmentId: command.environmentId,
      _organizationId: command.organizationId,
      _subscriberId: command.subscriberId,
      _templateId: notification._templateId,
      _messageTemplateId: chatChannel.template._id,
      channel: ChannelTypeEnum.CHAT,
      transactionId: command.transactionId,
      chatWebhookUrl: chatWebhookUrl,
      content,
      providerId: subscriberChannel.providerId,
      _jobId: command.jobId,
    });

    const integration = (
      await this.getDecryptedIntegrationsUsecase.execute(
        GetDecryptedIntegrationsCommand.create({
          organizationId: command.organizationId,
          environmentId: command.environmentId,
          providerId: subscriberChannel.providerId,
          channelType: ChannelTypeEnum.CHAT,
          findOne: true,
          active: true,
        })
      )
    )[0];

    await this.createExecutionDetails.execute(
      CreateExecutionDetailsCommand.create({
        environmentId: command.environmentId,
        organizationId: command.organizationId,
        subscriberId: command.subscriberId,
        jobId: command.jobId,
        notificationId: notification._id,
        notificationTemplateId: notification._templateId,
        transactionId: command.transactionId,
        channel: StepTypeEnum.SMS,
        detail: 'Message created',
        source: ExecutionDetailsSourceEnum.INTERNAL,
        status: ExecutionDetailsStatusEnum.SUCCESS,
        providerId: integration.providerId,
        messageId: message._id,
        isTest: false,
        isRetry: false,
        raw: JSON.stringify(content),
      })
    );

    if (chatWebhookUrl && integration) {
      await this.sendMessage(chatWebhookUrl, integration, content, message, command, notification);

      return;
    }

    await this.sendErrors(chatWebhookUrl, integration, message, command, notification);
  }

  private async sendErrors(
    chatWebhookUrl,
    integration: IntegrationEntity,
    message: MessageEntity,
    command: SendMessageCommand,
    notification: NotificationEntity
  ) {
    if (!chatWebhookUrl) {
      await this.createExecutionDetails.execute(
        CreateExecutionDetailsCommand.create({
          environmentId: command.environmentId,
          organizationId: command.organizationId,
          subscriberId: command.subscriberId,
          jobId: command.jobId,
          notificationId: notification._id,
          notificationTemplateId: notification._templateId,
          messageId: message._id,
          providerId: integration?.providerId,
          transactionId: command.transactionId,
          channel: StepTypeEnum.CHAT,
          detail: `Subscriber does not have active chat channel Id`,
          source: ExecutionDetailsSourceEnum.INTERNAL,
          status: ExecutionDetailsStatusEnum.FAILED,
          isTest: false,
          isRetry: false,
        })
      );

      await this.createLogUsecase.execute(
        CreateLogCommand.create({
          transactionId: command.transactionId,
          status: LogStatusEnum.ERROR,
          environmentId: command.environmentId,
          organizationId: command.organizationId,
          text: 'Subscriber does not have active chat channel Id',
          userId: command.userId,
          subscriberId: command.subscriberId,
          code: LogCodeEnum.SUBSCRIBER_MISSING_CHAT_CHANNEL_ID,
          templateId: notification._templateId,
          raw: {
            payload: command.payload,
            triggerIdentifier: command.identifier,
          },
        })
      );
      await this.messageRepository.updateMessageStatus(
        message._id,
        'warning',
        null,
        'no_subscriber_chat_channel_id',
        'Subscriber does not have active chat channel id'
      );
    }
    if (!integration) {
      await this.createExecutionDetails.execute(
        CreateExecutionDetailsCommand.create({
          environmentId: command.environmentId,
          organizationId: command.organizationId,
          subscriberId: command.subscriberId,
          jobId: command.jobId,
          notificationId: notification._id,
          notificationTemplateId: notification._templateId,
          messageId: message._id,
          transactionId: command.transactionId,
          channel: StepTypeEnum.CHAT,
          detail: `Subscriber does not have an active chat integration`,
          source: ExecutionDetailsSourceEnum.INTERNAL,
          status: ExecutionDetailsStatusEnum.FAILED,
          isTest: false,
          isRetry: false,
        })
      );
      await this.sendErrorStatus(
        message,
        'warning',
        'chat_missing_integration_error',
        'Subscriber does not have an active chat integration',
        command,
        notification,
        LogCodeEnum.MISSING_CHAT_INTEGRATION
      );
    }
  }

  private async sendMessage(
    chatWebhookUrl: string,
    integration: IntegrationEntity,
    content: string,
    message: MessageEntity,
    command: SendMessageCommand,
    notification: NotificationEntity
  ) {
    try {
      const chatHandler = this.chatFactory.getHandler(integration);

      const result = await chatHandler.send({
        webhookUrl: chatWebhookUrl,
        content,
      });

      await this.createExecutionDetails.execute(
        CreateExecutionDetailsCommand.create({
          environmentId: command.environmentId,
          organizationId: command.organizationId,
          subscriberId: command.subscriberId,
          jobId: command.jobId,
          notificationId: notification._id,
          notificationTemplateId: notification._templateId,
          messageId: message._id,
          providerId: integration.providerId,
          transactionId: command.transactionId,
          channel: StepTypeEnum.CHAT,
          detail: 'Message sent',
          source: ExecutionDetailsSourceEnum.INTERNAL,
          status: ExecutionDetailsStatusEnum.SUCCESS,
          isTest: false,
          isRetry: false,
          raw: JSON.stringify(result),
        })
      );
    } catch (e) {
      await this.createExecutionDetails.execute(
        CreateExecutionDetailsCommand.create({
          environmentId: command.environmentId,
          organizationId: command.organizationId,
          subscriberId: command.subscriberId,
          jobId: command.jobId,
          notificationId: notification._id,
          notificationTemplateId: notification._templateId,
          messageId: message._id,
          providerId: integration.providerId,
          transactionId: command.transactionId,
          channel: StepTypeEnum.CHAT,
          detail: 'Unexpected provider error',
          source: ExecutionDetailsSourceEnum.INTERNAL,
          status: ExecutionDetailsStatusEnum.FAILED,
          isTest: false,
          isRetry: false,
          raw: JSON.stringify(e),
        })
      );

      await this.sendErrorStatus(
        message,
        'error',
        'unexpected_chat_error',
        e.message || e.name || 'Un-expect CHAT provider error',
        command,
        notification,
        LogCodeEnum.CHAT_ERROR,
        e
      );
    }
  }
}
