/**
 * trackerAnalytics router — read-only aggregations behind the Trackers page visualizations.
 * Every procedure is a thin wrapper over a @bullet/db aggregation function; ALL bucketing /
 * streak / correlation logic lives in the db package (per the architectural rule).
 */

import {
  findQuietPattern,
  trackerBooleanStreaks,
  trackerDailySeries,
  trackerYearInPixels,
} from '@bullet/db'
import { publicProcedure, router } from '../trpc'
import {
  quietPatternInput,
  trackerSeriesInput,
  trackerStreaksInput,
  trackerYearInPixelsInput,
} from './inputs'

export const trackerAnalyticsRouter = router({
  dailySeries: publicProcedure
    .input(trackerSeriesInput)
    .query(({ ctx, input }) =>
      trackerDailySeries(ctx.db, input.trackerId, { tzOffsetMinutes: input.tzOffsetMinutes }),
    ),

  yearInPixels: publicProcedure.input(trackerYearInPixelsInput).query(({ ctx, input }) =>
    trackerYearInPixels(ctx.db, input.trackerId, input.year, {
      tzOffsetMinutes: input.tzOffsetMinutes,
    }),
  ),

  streaks: publicProcedure
    .input(trackerStreaksInput)
    .query(({ ctx, input }) =>
      trackerBooleanStreaks(ctx.db, input.trackerId, { tzOffsetMinutes: input.tzOffsetMinutes }),
    ),

  quietPattern: publicProcedure.input(quietPatternInput).query(({ ctx, input }) =>
    findQuietPattern(ctx.db, ctx.ownerId, {
      tzOffsetMinutes: input.tzOffsetMinutes,
      minDays: input.minDays,
    }),
  ),
})
