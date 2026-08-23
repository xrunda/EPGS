import { registerDecorator, ValidationOptions, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isValidCronExpression } from '@epgs/notification-push';

/**
 * `@IsValidCron()` - property decorator for push-rule cron expressions.
 * Delegates to the shared package's validator (the same one the worker's
 * scheduler uses to test due-ness), so what the API accepts is exactly what
 * the worker can evaluate.
 */
@ValidatorConstraint({ name: 'isValidCron', async: false })
export class IsValidCronConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidCronExpression(value.trim());
  }

  defaultMessage(): string {
    return 'cron must be a valid 5-field cron expression (minute hour day month day-of-week)';
  }
}

export function IsValidCron(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      constraints: [],
      validator: IsValidCronConstraint,
    });
  };
}
