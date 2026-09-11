import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * class-validator decorator asserting a field equals a sibling field on the
 * same DTO (e.g. confirmPassword === password). Originally written for
 * auth/dto/auth.dto.ts's ChangePasswordDto and duplicated verbatim into two
 * more DTOs (issue #78/#81) before being extracted here.
 */
export function MatchesProperty(property: string, options?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'matchesProperty',
      target: object.constructor,
      propertyName: String(propertyName),
      constraints: [property],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const related = (args.object as Record<string, unknown>)[args.constraints[0] as string];
          return value === related;
        },
      },
    });
  };
}
