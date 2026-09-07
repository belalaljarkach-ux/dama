# إعداد SQL Server لتطبيق سجل بوابة المجبل

هذه الورقة تُرسَل لقسم تقنية المعلومات. المطلوب منهم **ثلاثة أوامر** وثلاثة
إعدادات — لا أكثر.

---

## المطلوب من قسم الـ IT

### 1. إنشاء قاعدة البيانات ومستخدمها

```sql
CREATE DATABASE gate_log;
GO

USE gate_log;
GO

CREATE LOGIN gatelog_app WITH PASSWORD = 'ضع-كلمة-مرور-قوية-هنا';
GO

CREATE USER gatelog_app FOR LOGIN gatelog_app;
ALTER ROLE db_owner ADD MEMBER gatelog_app;
GO
```

**لماذا `db_owner`؟** التطبيق ينشئ جداوله وفهارسه بنفسه عند أول تشغيل. إن
كانت السياسة تمنع `db_owner`، فالبديل هو تنفيذ سكربت الإنشاء يدويًا مرة
واحدة ثم منح `db_datareader` و `db_datawriter` فقط — أخبرني وأجهّز السكربت.

الصلاحية محصورة بقاعدة `gate_log` وحدها ولا تمسّ أي قاعدة أخرى على الخادم.

### 2. تفعيل مصادقة SQL Server

التطبيق يتصل باسم مستخدم وكلمة مرور، لا بحساب Windows. إن كان الخادم مضبوطًا
على **Windows Authentication** فقط، فعّل الوضع المختلط:

**SSMS** → زر يمين على اسم الخادم → **Properties** → **Security**
→ **SQL Server and Windows Authentication mode** → ثم **أعد تشغيل الخدمة**.

### 3. تفعيل بروتوكول TCP/IP

**هذه أشيع نقطة فشل، خصوصًا في نسخة Express حيث TCP/IP معطّل افتراضيًا.**

**SQL Server Configuration Manager** → **SQL Server Network Configuration**
→ **Protocols for MSSQLSERVER** → **TCP/IP** → **Enabled = Yes**
→ ثم **أعد تشغيل الخدمة**.

إن كان التطبيق سيعمل على السيرفر نفسه فلا حاجة لفتح المنفذ في جدار الحماية.
إن كان على جهاز آخر، افتح **TCP 1433** بين الجهازين فقط.

---

## الإعداد في التطبيق

أنشئ ملف `gatelog.config.json` في مجلد التطبيق:

```json
{
  "driver": "mssql",
  "mssqlServer": "127.0.0.1",
  "mssqlPort": 1433,
  "mssqlDatabase": "gate_log",
  "mssqlUser": "gatelog_app",
  "mssqlPassword": "كلمة-المرور",
  "port": 8787
}
```

**إن كانت النسخة مُسمّاة** (الشائع مع Express، مثل `SERVER\SQLEXPRESS`):

```json
  "mssqlServer": "127.0.0.1",
  "mssqlInstance": "SQLEXPRESS"
```

ويجب حينها تشغيل خدمة **SQL Server Browser**، أو تحديد منفذ ثابت في
Configuration Manager ووضعه في `mssqlPort`.

ثم قيّد صلاحيات الملف — فهو يحتوي كلمة المرور:

```powershell
icacls gatelog.config.json /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(F)"
```

---

## التحقّق قبل التشغيل

```bash
node test/verify-mssql.js
```

هذه الأداة تفحص بالترتيب: الاتصال ← الصلاحيات ← إنشاء الجداول ← دعم الفهرس
المُرشَّح ← تخزين العربية ← منع الازدواج ← المعاملات. وتقول لك أين توقّفت
بالضبط بدل رسالة عطل واحدة غامضة. كل ما تكتبه يُحذف في نهاية الفحص.

عند نجاح كل الفحوص:

```bash
node server.js
```

---

## ما ينشئه التطبيق في قاعدة البيانات

ستة جداول في مخطّط `dbo`:

| الجدول | المحتوى |
|---|---|
| `vehicles` | الآليات وكيلومتراج البداية |
| `entries` | كل عملية خروج/دخول |
| `settings` | كلمتا المرور مُجزّأتين بـ PBKDF2 |
| `sessions` | الجلسات النشطة |
| `login_attempts` | عدّاد المحاولات الفاشلة لكل جهاز |
| `audit` | سجل التدقيق لكل حذف وتعديل |

### قراران تقنيان يستحقان الانتباه

**كل الأعمدة النصية `NVARCHAR` لا `VARCHAR`.** النوع `VARCHAR` يخزّن بترميز
صفحة الشيفرة الافتراضية للخادم، وعليها تتحوّل أسماء السائقين والآليات العربية
إلى `????` إن لم تكن ترتيبية الخادم عربية. `NVARCHAR` يخزّن Unicode دائمًا،
فيعمل مهما كانت إعدادات الخادم. أداة `verify-mssql.js` تختبر هذا صراحةً.

**التواريخ والأوقات مخزّنة نصوصًا لا `DATE`/`TIME`.** هذا مقصود: الأنواع
الزمنية تُفسَّر حسب منطقة زمنية، وهو ما أفسد كل حسابات المدة في نسخة
Google Sheets السابقة.

### الفهرس الذي يفرض قاعدة العمل

```sql
CREATE UNIQUE INDEX ux_one_open_trip ON dbo.entries(vehicle) WHERE status = N'out';
```

فهرس مُرشَّح (filtered index) يضمن **رحلة مفتوحة واحدة لكل آلية**. هذا ما يمنع
فعليًا خروج آلية هي أصلًا في الخارج حين يرسل جهازان على البوابة الطلب في نفس
اللحظة — الفحص في الكود وحده لا يكفي في هذه الحالة.

---

## النسخ الاحتياطي

التطبيق يكتب لقطة JSON كل 24 ساعة في `data/backups` ويحتفظ بآخر 60. هذه
**ليست بديلًا** عن النسخ الاحتياطي الرسمي — أضيفوا `gate_log` إلى خطة الصيانة
المعتادة على الخادم:

```sql
BACKUP DATABASE gate_log
TO DISK = 'D:\Backups\gate_log.bak'
WITH FORMAT, COMPRESSION, STATS = 10;
```

---

## قائمة تحقّق سريعة

- [ ] `CREATE DATABASE gate_log`
- [ ] مستخدم `gatelog_app` بصلاحية `db_owner` على `gate_log` فقط
- [ ] وضع المصادقة المختلط مفعّل + إعادة تشغيل الخدمة
- [ ] TCP/IP مفعّل + إعادة تشغيل الخدمة
- [ ] `gatelog.config.json` مُعبّأ وصلاحياته مقيّدة
- [ ] `node test/verify-mssql.js` يمرّ بلا فشل
- [ ] `gate_log` مضافة إلى خطة النسخ الاحتياطي
