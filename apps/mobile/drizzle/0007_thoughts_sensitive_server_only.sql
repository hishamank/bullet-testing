-- `thoughts.sensitive` is server-only now: the phone no longer pulls it. The column stays (older
-- phones have it; dropping it would rebuild the table) but is unused and defaults to false, and
-- any flag pulled before is cleared here.
UPDATE `thoughts` SET `sensitive` = false;
