import 'package:flutter/material.dart';

/// Centralized design tokens for the Universal Scrapper app (light theme).
class AppColors {
  AppColors._();

  static const accent = Color(0xFF7C6AF7);
  static const bg = Color(0xFFF6F6F8);
  static const surface = Color(0xFFFFFFFF);
  static const surfaceMuted = Color(0xFFF0F0F4);
  static const border = Color(0xFFE4E4EA);
  static const muted = Color(0xFF6E6E78);
  static const text = Color(0xFF1A1A22);
  static const success = Color(0xFF4ADE80);
  static const error = Color(0xFFF87171);
  static const warn = Color(0xFFE07B00);
  static const handle = Color(0xFFC8C8D0);
}

/// Motion timings/curves used across the app.
class AppMotion {
  AppMotion._();

  static const fast = Duration(milliseconds: 160);
  static const normal = Duration(milliseconds: 260);
  static const slow = Duration(milliseconds: 360);

  static const easeOut = Curves.easeOutCubic;
  static const spring = Curves.easeOutBack;
}
