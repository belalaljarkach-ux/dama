-- ============================================================================
-- Migration 003 — تبريرات تنبيهات تجاوز المسافة (جدول alert_justifications)
--
-- السبب: تنبيه تجاوز المسافة صار يُقاس بحدّ ثابت بالكيلومتر (يحدّده مدير الآليات)، ويكتب
-- مدير الآليات تبريرًا إلزاميًا لكل تنبيه؛ بعد حفظه يختفي من قائمته المعلّقة وينتقل للأدمن
-- مع التبرير ومن كتبه ومتى. التبرير يحتاج جدولًا يحفظه، وبقية الميزة (حفظ الحد) تستعمل جدول
-- settings القائم فلا تحتاج شيئًا.
--
-- لا يُطبَّق تلقائيًا: التطبيق لا ينفّذ هذا الملف ولا ينشئ الجدول في قاعدة قائمة. شغّله يدويًا
-- مرة واحدة بحساب يملك CREATE TABLE على قاعدة gate_log.
--
-- قبل التطبيق: يعمل كل شيء كما كان عدا حفظ التبرير: يرفضه الخادم برسالة واضحة (409) وتبقى
-- قائمة المعلّقة ظاهرة. بعد التطبيق يلتقط التطبيق الجدول خلال 30 ثانية دون إعادة تشغيل.
--
-- الحالات: pending «بانتظار التبرير» مشتقّة (تنبيه قائم بلا صف)، وjustified «مُبرَّر» هي الحالة
-- الوحيدة المخزَّنة. الصف لا يُعدَّل ولا يُحذف: الفهرس الفريد (entry_id, alert_type) يمنع
-- استبدال تبرير سابق، والمسافة والحد لقطة وقت التبرير. كل حفظ يُدوَّن أيضًا في جدول audit
-- (alert_justify) وكل تغيير للحد (alert_limit_set بالقيمة قبل/بعد).
--
-- الأثر: إنشاء جدول جديد فقط؛ لا يمسّ أي جدول أو بيان قائم. آمن للتشغيل أكثر من مرة (idempotent).
-- القواعد الجديدة (من الصفر) تنشئه تلقائيًا فلا تحتاج هذا الملف. MongoDB لا يحتاجه.
--
-- التشغيل (SSMS أو sqlcmd) على قاعدة gate_log:
--   sqlcmd -S <server> -d gate_log -i migrations\003-alert-justifications.sql
-- ============================================================================

IF OBJECT_ID('dbo.alert_justifications', 'U') IS NULL
    CREATE TABLE dbo.alert_justifications (
        id            NVARCHAR(64)   NOT NULL PRIMARY KEY,
        entry_id      NVARCHAR(64)   NOT NULL,
        alert_type    NVARCHAR(16)   NOT NULL CONSTRAINT df_alert_just_type DEFAULT N'distance',
        status        NVARCHAR(16)   NOT NULL CONSTRAINT df_alert_just_status DEFAULT N'justified'
                        CONSTRAINT ck_alert_just_status CHECK (status IN (N'justified')),
        vehicle       NVARCHAR(120)  NOT NULL,
        driver        NVARCHAR(120)  NOT NULL,
        customer      NVARCHAR(200)  NOT NULL,
        trip_date     NVARCHAR(10)   NOT NULL,
        depart_time   NVARCHAR(5)    NULL,
        return_date   NVARCHAR(10)   NULL,
        return_time   NVARCHAR(5)    NULL,
        distance_km   FLOAT          NOT NULL,
        limit_km      FLOAT          NOT NULL,
        justification NVARCHAR(1000) NOT NULL,
        justified_by  NVARCHAR(120)  NOT NULL,
        justified_at  NVARCHAR(40)   NOT NULL
    );

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'ux_alert_just_entry' AND object_id = OBJECT_ID('dbo.alert_justifications'))
    CREATE UNIQUE INDEX ux_alert_just_entry ON dbo.alert_justifications(entry_id, alert_type);

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'ix_alert_just_at' AND object_id = OBJECT_ID('dbo.alert_justifications'))
    CREATE INDEX ix_alert_just_at ON dbo.alert_justifications(justified_at DESC);

-- تحقّق: يجب أن يُرجع صفًا واحدًا (الجدول) ثم عدد الصفوف (0 في البداية).
SELECT OBJECT_ID('dbo.alert_justifications', 'U') AS table_id;
SELECT COUNT(*) AS justifications FROM dbo.alert_justifications;
