-- ============================================================================
-- Migration 002 — نوع الزيارة (زبون | ضيف) في جدول guest_visits
--
-- السبب: لوحة الأدمن تعرض الآن «عدد الزبائن» و«عدد الضيوف» من سجلات البوابة. جدول
-- guest_visits الحالي لا يميّز بينهما، فنضيف عمود visit_type بدل إنشاء جدول مكرّر.
--
-- لا يُطبَّق تلقائيًا: التطبيق لا ينفّذ هذا الملف ولا يعدّل جدولًا قائمًا. شغّله يدويًا
-- مرة واحدة بحساب يملك ALTER على قاعدة gate_log.
--
-- قبل التطبيق: التطبيق يعمل كما كان؛ كل السجلات تُحتسب «ضيوفًا» وبطاقة «عدد الزبائن» = 0
-- (مع تلميح)، ولا يظهر خيار «زبون» في نموذج البوابة، ويرفض الخادم تسجيل «زبون» بوضوح.
-- بعد التطبيق: يلتقط التطبيق العمود خلال 30 ثانية (دون إعادة تشغيل) ويظهر الخيار.
--
-- الأثر: إضافة عمود فقط. السجلات القائمة تأخذ القيمة الافتراضية 'guest' (= تُحتسب ضيوفًا
-- كما كانت عمليًا) ولا يُحذف ولا يُعدَّل أي بيان آخر. آمن للتشغيل أكثر من مرة (idempotent).
-- القواعد الجديدة (إنشاء من الصفر) تنشئ العمود مع الجدول فلا تحتاج هذا الملف.
-- MongoDB بلا مخطط فلا تحتاجه. SQLite (تطوير فقط) لقاعدة قائمة:
--   ALTER TABLE guest_visits ADD COLUMN visit_type TEXT NOT NULL DEFAULT 'guest'
--     CHECK (visit_type IN ('customer','guest'));
--
-- التشغيل (SSMS أو sqlcmd) على قاعدة gate_log:
--   sqlcmd -S <server> -d gate_log -i migrations\002-add-guest-visit-type.sql
-- ============================================================================

IF COL_LENGTH('dbo.guest_visits', 'visit_type') IS NULL
    ALTER TABLE dbo.guest_visits
        ADD visit_type NVARCHAR(8) NOT NULL
            CONSTRAINT df_guest_visits_type DEFAULT N'guest'
            CONSTRAINT ck_guest_visits_type CHECK (visit_type IN (N'customer', N'guest'));

-- تحقّق: يجب أن يُرجع صفًا واحدًا (visit_type) ثم توزيع الأنواع الحالي.
SELECT name, max_length / 2 AS chars FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.guest_visits') AND name = 'visit_type';
