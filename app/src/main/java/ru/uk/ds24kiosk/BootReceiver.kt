package ru.uk.ds24kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Автозапуск после перезагрузки планшета. В "dev"-сборке ничего не делает,
 * чтобы не запускать киоск на личном телефоне при каждой перезагрузке.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!BuildConfig.IS_KIOSK) return

        val launchIntent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(launchIntent)
    }
}
