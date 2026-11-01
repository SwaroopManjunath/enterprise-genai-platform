import { Public } from '@genai/auth';
import { Controller, Get } from '@nestjs/common';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
