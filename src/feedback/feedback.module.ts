import { Module } from '@nestjs/common';
import { OutcomesModule } from '../outcomes/outcomes.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

@Module({
  // OutcomesModule supplies the 0107 confirmed/rejected outcome writer.
  imports: [OutcomesModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
