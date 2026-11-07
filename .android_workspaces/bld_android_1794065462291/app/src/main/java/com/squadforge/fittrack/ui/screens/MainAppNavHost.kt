package com.squadforge.fittrack.ui.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController

sealed class Screen(val route: String) {
    object Home : Screen("home")
    object Details : Screen("details")
    object Permissions : Screen("permissions")
}

@Composable
fun MainAppNavHost(
    modifier: Modifier = Modifier,
    navController: NavHostController = rememberNavController(),
    startDestination: String = Screen.Home.route
) {
    NavHost(
        navController = navController,
        startDestination = startDestination,
        modifier = modifier
    ) {
        composable(Screen.Home.route) {
            HomeScreen(
                onNavigateToDetails = { navController.navigate(Screen.Details.route) },
                onNavigateToPermissions = { navController.navigate(Screen.Permissions.route) }
            )
        }
        composable(Screen.Details.route) {
            DetailsScreen(onNavigateBack = { navController.popBackStack() })
        }
        composable(Screen.Permissions.route) {
            PermissionsScreen(onNavigateBack = { navController.popBackStack() })
        }
    }
}
