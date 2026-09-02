package ru.uk.ds24kiosk

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Process
import kotlin.system.exitProcess

/**
 * Только для "kiosk"-сборки: на необработанном крэше планирует через
 * AlarmManager перезапуск MainActivity и завершает текущий процесс.
 * В "dev"-сборке не устанавливается — там удобнее видеть обычный крэш.
 */
object CrashWatchdog {

    fun install(context: Context) {
        val appContext = context.applicationContext
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()

        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                scheduleRestart(appContext)
            } catch (_: Throwable) {
                // не даём вторичной ошибке помешать завершению процесса ниже
            }
            previousHandler?.uncaughtException(thread, throwable)
            Process.killProcess(Process.myPid())
            exitProcess(10)
        }
    }

    private fun scheduleRestart(context: Context) {
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.set(AlarmManager.RTC, System.currentTimeMillis() + 2000, pendingIntent)
    }
}
