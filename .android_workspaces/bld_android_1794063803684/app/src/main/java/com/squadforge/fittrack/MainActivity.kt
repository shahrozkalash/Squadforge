package com.squadforge.fittrack

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.squadforge.fittrack.ui.theme.FitTrackTheme
import com.squadforge.fittrack.ui.screens.MainAppNavHost

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            FitTrackTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    MainAppNavHost(
                        modifier = Modifier.padding(innerPadding)
                    )
                }
            }
        }
    }
}
